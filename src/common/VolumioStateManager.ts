import _ from 'lodash';
import { getErrorMessage, kewToJSPromise } from './Util';
import { type ServiceContext, type Logger } from './ServiceContext';
import { type PlayerStatus, type PlayerStatusProvider } from './PlayerStatusProvider';
import { type PlayerControl } from './PlayerControl';
import { type VolumioContext } from './VolumioContext';

export interface VolumioStateManagerOptions<S extends PlayerStatus> {
  context: ServiceContext;
  control: PlayerControl<S>;
  statusProvider: PlayerStatusProvider<S>;
  logger: Logger;
}

export interface TrackInfo {
  uri: string;
  streamUrl: string;
  title?: string;
  artist?: string;
  album?: string;
  albumart?: string;
  trackType?: string;
  duration?: number;
  samplerate?: string;
  bitdepth?: string;
  bitrate?: string;
  channels?: number;
}

export interface ObservedState {
  status: 'play' | 'pause' | 'stop';
  title?: string;
  artist?: string;
  album?: string;
  albumart?: string;
  uri: string;
  trackType?: string;
  seek?: number; // milliseconds
  duration?: number; // seconds
  samplerate?: string;
  bitdepth?: string;
  bitrate?: string;
  channels?: number;
}

export interface VolumioState extends ObservedState {
  service: string;
  volume?: number;
  dbVolume?: number;
  disableVolumeControl?: boolean;
  mute?: boolean;
  stream?: boolean;
  repeat?: boolean;
  repeatSingle?: boolean;
  random?: boolean;
}

const EMPTY_STATE: Omit<VolumioState, 'service'> = {
  status: 'stop',
  albumart: '/albumart',
  uri: '',
  seek: 0,
  duration: 0,
} as const;

export class VolumioStateManager<S extends PlayerStatus> {

  #context: ServiceContext;
  #logger: Logger;
  #suppliedTrackInfo: TrackInfo | null = null;
  #disposed: boolean = false;
  #volatileCallback: (() => void) | null = null;
  #control: PlayerControl<S>;
  #statusProvider: PlayerStatusProvider<S>;
  #statusListener: (status: S) => void;
  #timeListener: (time: number) => void;
  #unsetVolatileOnStop: VolumioContext['unsetVolatileOnStop'];
  #lastPushedState: VolumioState | null = null;

  constructor(options: VolumioStateManagerOptions<S>) {
    this.#context = options.context;
    this.#logger = options.logger;
    this.#control = options.control;
    this.#statusProvider = options.statusProvider;
    this.#statusListener = (status) => this.#handlePlayerStatusChange(status);
    this.#timeListener = (time) => this.#handlePlayerTimeChange(time);
    this.#statusProvider.on('status', this.#statusListener);
    this.#statusProvider.on('time', this.#timeListener);
    this.#unsetVolatileOnStop = options.context.volumio?.unsetVolatileOnStop ?? 'always';
  }

  async prepareForPlayback(trackInfo: TrackInfo) {
    if (this.#disposed) {
      throw Error('VolumioStateManager is disposed');
    }
    await this.#stopCurrentServiceAndSetVolatile();
    await this.#setRepeatSingle();

    this.#lastPushedState = null;
    this.#pushState({
      ...EMPTY_STATE,
      ..._.omit(trackInfo, ['streamUrl']),
      status: 'pause'
    });

    this.#suppliedTrackInfo = trackInfo;
  }

  #handlePlayerTimeChange(time: number) {
    if (
      !this.#context.volumio ||
      !this.#context.volumio.statemachine.volatileState ||
      this.#statusProvider.getStatus().state  === 'stopped'
    ) {
      return;
    }
    let seek = time * 1000;
    if (this.#context.volumio.stateTransformer?.modifyVolatileSeekBeforeSet) {
      seek = this.#context.volumio.stateTransformer.modifyVolatileSeekBeforeSet(seek);
    }
    this.#context.volumio.statemachine.volatileState.seek = seek;
  }

  #handlePlayerStatusChange(status: S) {
    if (status.state === 'stopped') {
      if (
        this.#unsetVolatileOnStop === 'always' ||
        // conrol.isStopping() returns true if stop() was called
        (this.#unsetVolatileOnStop === 'manual' && this.#control.isStopping())
      ) {
        if (this.#context.volumio) {
          this.#logger.info('Player status "stopped" - unsetting ourselves as current service...');
        }
        // "stop" state will be pushed when unsetting volatile state
        // - see onUnsetVolatile() callback
        this.unsetVolatile();
        return;
      }
      this.#logger.info(`Player status "stopped" - skip unset volatile because unset condition is "${this.#unsetVolatileOnStop}"`);
      return;
    }
    if (this.#control.isStopping()) {
      return;
    }

    void (async () => {
      // Ensure we're current service
      await this.#stopCurrentServiceAndSetVolatile();
      this.#pushState(this.getObservedStateFromPlayerStatus(status));
    })();
  }

  protected getObservedStateFromPlayerStatus(status: S): ObservedState {
    return {
      status: status.state === 'playing' ? 'play' :
              status.state === 'paused' ? 'pause' : 'stop',
      uri: this.#suppliedTrackInfo?.uri || '',
      title: this.#suppliedTrackInfo?.title || status.title,
      artist: this.#suppliedTrackInfo?.artist || status.artist,
      album: this.#suppliedTrackInfo?.album || status.album,
      albumart: this.#suppliedTrackInfo?.albumart || '/albumart',
      trackType: this.#suppliedTrackInfo?.trackType || status.trackType,
      duration: this.#suppliedTrackInfo?.duration || status.duration,
      samplerate: this.#suppliedTrackInfo?.samplerate || status.samplerate,
      bitdepth: this.#suppliedTrackInfo?.bitdepth || status.bitdepth,
      bitrate: this.#suppliedTrackInfo?.bitrate || status.bitrate,
      channels: this.#suppliedTrackInfo?.channels || status.channels,
    };
  }

  #pushState(observedState?: ObservedState) {
    if (!this.#context.volumio) {
      return;
    }
    if (!observedState) {
      observedState = this.getObservedStateFromPlayerStatus(this.#statusProvider.getStatus());
    }     
    const sm = this.#context.volumio.statemachine;
    let state: VolumioState = {
      ...observedState,
      service: this.#context.serviceName,
      seek: this.#statusProvider.getStatus().time * 1000,
      stream: false,
      repeat: sm.currentRepeat,
      repeatSingle: sm.currentRepeatSingleSong,
      random: sm.currentRandom,
      volume: sm.currentVolume ?? undefined,
      dbVolume: sm.currentDbVolume ?? undefined,
      mute: sm.currentMute,
      disableVolumeControl: sm.currentDisableVolumeControl
    };

    if (this.#context.volumio.stateTransformer?.transformStateBeforePush) {
      state = this.#context.volumio.stateTransformer.transformStateBeforePush(state);
    }

    if (!_.isEqual(state, this.#lastPushedState)) {
      this.#lastPushedState = _.clone(state);
      this.#logger.info(`Push Volumio state: ${JSON.stringify(state)}`);
      this.#context.volumio.commandRouter.servicePushState(state, this.#context.serviceName);
    }
  }

  dispose() {
    this.#statusProvider.off('status', this.#statusListener);
    this.#statusProvider.off('time', this.#timeListener);
    this.#disposed = true;
  }

  async #stopCurrentServiceAndSetVolatile() {
    if (!this.#context.volumio || this.isCurrentServiceAndVolatile()) {
      return;
    }
    
    const { statemachine, mpdPlugin, commandRouter } = this.#context.volumio;

    const stopCurrentServicePlayback = () => {
      try {
        // Tell mpd plugin to ignore changes it detects, so it won't push its own states that could mess up the statemachine.
        mpdPlugin.ignoreUpdate(true);
        return kewToJSPromise(commandRouter.volumioStop());
      }
      catch (error) {
        this.#logger.error(`An error occurred while stopping playback by current service: ${getErrorMessage(error)}`);
        this.#logger.error('Continuing anyway...');
      }
    };

    // Stop any playback by the currently active service
    this.#logger.info('Stopping playback by current service...');
    statemachine.setConsumeUpdateService(undefined);
    await stopCurrentServicePlayback();

    // Unset any volatile state of currently active service
    if (statemachine.isVolatile) {
      statemachine.unSetVolatile();
    }

    // Set volatile
    this.#logger.info('Setting ourselves as the current service...');
    if (!this.#volatileCallback) {
      this.#volatileCallback = this.onUnsetVolatile.bind(this);
    }
    statemachine.setVolatile({
      service: this.#context.serviceName,
      callback: this.#volatileCallback
    });
    statemachine.setConsumeUpdateService(undefined);
  }

  unsetVolatile() {
    if (!this.#context.volumio) {
      return;
    }
    this.#context.volumio.statemachine.unSetVolatile();
  }

  // Callback that gets called by statemachine when unsetting volatile state
  onUnsetVolatile() {
    if (!this.#context.volumio) {
      return;
    }
    this.#logger.info('Volatile state unset, stopping playback (if any)...');
    this.#pushState({ ...EMPTY_STATE, });
    this.#lastPushedState = null
    this.#context.volumio.mpdPlugin.ignoreUpdate(false);

    /**
     * There is no graceful handling of switching from one music service plugin to another
     * in Volumio. Statemachine calls volatile callbacks in unsetVolatile(), but does not
     * wait for them to complete. That means there is no chance to actually clean things up before
     * moving to another music service.
     * When we call stop() here, we should ideally be able to return a promise that resolves when
     * the output device is closed by mpv, with statemachine then proceeding to the next
     * music service. But since there is no such mechanism, if mpv is still in the process of stopping
     * playback, then you will most likely get an "Alsa device busy" error when the next music service
     * tries to access it.
     * No solution I can think of, or am I doing this the wrong way?
     */
    if (this.#statusProvider.getStatus().state !== 'stopped') {
      void this.#control.stop();
    }
  }

  #getCurrentService() {
    if (!this.#context.volumio) {
      return null;
    }
    const currentstate = this.#context.volumio.commandRouter.volumioGetState();
    return (currentstate !== undefined && currentstate.service !== undefined) ? {
      service: currentstate.service,
      isVolatile: currentstate.volatile
    } : null;
  }

  isCurrentServiceAndVolatile() {
    const { service, isVolatile } = this.#getCurrentService() || {};
    return service === this.#context.serviceName && !!isVolatile;
  }

  async setRepeat(value: boolean, repeatSingle = false) {
    if (!this.#context.volumio) {
      return;
    }
    const sm = this.#context.volumio.statemachine;
    const oldRepeat = sm.currentRepeat;
    const oldRepeatSingle = sm.currentRepeatSingleSong;

    // Do what statemachine does
    sm.currentRepeat = value;
    sm.currentRepeatSingleSong = sm.currentRepeat && repeatSingle;

    await this.#setRepeatSingle();

    if (sm.currentRepeat !== oldRepeat || sm.currentRepeatSingleSong !== oldRepeatSingle) {
      this.#pushState();
    }
  }

  async #setRepeatSingle() {
    if (!this.#context.volumio) {
      return;
    }
    const sm = this.#context.volumio.statemachine;
    return await this.#control.setRepeatSingle(sm.currentRepeat && sm.currentRepeatSingleSong);
  }

  setRandom(value: boolean) {
    if (!this.#context.volumio) {
      return;
    }
    const sm = this.#context.volumio.statemachine;
    const oldRandom = sm.currentRandom;

    // Do what statemachine does
    sm.currentRandom = value;
    
    if (sm.currentRandom !== oldRandom) {
      this.#pushState();
    }
  }
}