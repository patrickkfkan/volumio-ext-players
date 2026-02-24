import { PlayerControl } from "../common/PlayerControl";
import { ensureError } from "../common/Util";
import { type VLCServiceContext } from "./VLCService";
import { type VLCStatus, type VLCStatusProvider } from "./VLCStatusProvider";
import type * as VLC from 'vlc-client';

export interface VLCControlOptions {
  context: VLCServiceContext;
  client: VLC.Client;
  statusProvider: VLCStatusProvider;
}

export type MPVSeekMode =
  | "absolute"
  | "relative"
  | "absolute+exact"
  | "relative+exact"
  | "keyframe"
  | "percent";


export class VLCControl extends PlayerControl<VLCStatus> {
  #statusProvider: VLCStatusProvider;
  #client: VLC.Client;
  #emitStatusDuringSeekTimer: NodeJS.Timeout | null = null;

  constructor(options: VLCControlOptions) {
    super({
      statusProvider: options.statusProvider,
      volumio: options.context.volumio
    });
    this.#statusProvider = options.statusProvider;
    this.#client = options.client;
  }

  #resolveOnStatus(
    resolve: () => void,
    reject: (err: Error) => void,
    condition: (status: VLCStatus) => boolean,
    cmd?: string,
    timeout = 30000
  ) {
    const listener = (status: VLCStatus) => {
      if (condition(status)) {
        this.#statusProvider.off('status', listener);
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      this.#statusProvider.off('status', listener);
      reject(Error(`Operation timeout${cmd ? `: ${cmd}` : ''}`));
    }, timeout);

    this.#statusProvider.on('status', listener);
  }

  async doPlayFile(uri: string, start: number) {
    this.#cancelStatusEmitDuringSeek();
    return await new Promise<void>((resolve, reject) => {
      this.#resolveOnStatus(
        resolve,
        reject,
        (status) => status.state === 'playing' && (start === 0 || status.time >= start),
        `playFile "${uri}"; start=${start}`
      );
      // VLC doesn't have proper support for starting playback at a specific position.
      // Best we could do is play then seek.
      this.#client.playFile(uri)
        .then(() => start > 0 ? this.seek(start) : Promise.resolve())
        .catch((error: unknown) => reject(ensureError(error)));
    });
  }

  async doPlay() {
    this.#cancelStatusEmitDuringSeek();
    return await new Promise<void>((resolve, reject) => {
      this.#resolveOnStatus(
        resolve,
        reject,
        (status) => status.state === 'playing',
        'play'
      );
      this.#client.play()
        .catch((error: unknown) => reject(ensureError(error)));
    });
  }

  async doPause() {
    this.#cancelStatusEmitDuringSeek();
    return await new Promise<void>((resolve, reject) => {
      this.#resolveOnStatus(
        resolve,
        reject,
        (status) => status.state === 'paused',
        'pause'
      );
      this.#client.pause()
        .catch((error: unknown) => reject(ensureError(error)));
    });
  }

  async doStop() {
    this.#cancelStatusEmitDuringSeek();
    return await new Promise<void>((resolve, reject) => {
      this.#resolveOnStatus(
        resolve,
        reject,
        (status) => status.state === 'stopped',
        'stop'
      );
      this.#client.stop()
        .catch((error: unknown) => reject(ensureError(error)));
    });
  }

  doSeek(position: number) {
    this.#cancelStatusEmitDuringSeek();
    this.#beginStatusEmitDuringSeek();
    return this.#client.setTime(position);
  }

  doSetVolume(volume: number) {
    return this.#client.setVolume(volume);
  }

  doSetRepeatSingle(value: boolean) {
    return this.#client.setRepeating(value);
  }

  /**
   * When seeking, the time might fluctuate before stabilizing at the actual seeked-to position.
   * Here, we emit status events for 10 seconds -- hopefully the time would have stabilized by then.
   * @param targetPosition 
   * @returns 
   */
  #beginStatusEmitDuringSeek() {
    this.#cancelStatusEmitDuringSeek();

    const beginTime = Date.now();
    const timeout = 10000;
    
    const setTimer = () => {
      this.#emitStatusDuringSeekTimer = setTimeout(() => {
        const status = this.#statusProvider.getStatus();
        this.#statusProvider.emit('status', status);
        if (Date.now() - beginTime >= timeout) {
          this.#cancelStatusEmitDuringSeek();
        }
        else {
          setTimer();
        }
      }, 1000);
    }

    setTimer();
  }

  #cancelStatusEmitDuringSeek() {
    if (this.#emitStatusDuringSeekTimer) {
      clearTimeout(this.#emitStatusDuringSeekTimer);
      this.#emitStatusDuringSeekTimer = null;
    }
  }
}