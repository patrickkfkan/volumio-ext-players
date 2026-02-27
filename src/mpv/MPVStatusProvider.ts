import { type Logger } from '../common/ServiceContext';
import _ from 'lodash';
import { type MPVCommandSender } from './CommandSender';
import {
  type PlayerStatus,
  PlayerStatusProvider
} from '../common/PlayerStatusProvider';

export type MPVStatus = PlayerStatus;

interface InternalStatus extends MPVStatus {
  displayTitle?: string;
  idle: boolean;
  paused: boolean;
  isSeeking: boolean;
}

export interface MPVStatusProviderOptions {
  commandSender: MPVCommandSender;
  logger: Logger;
}

interface PropertyChangeEvent {
  subscriptionId: number;
  prop: ObservableProperty;
  data: any;
}

const TARGET_PROPS = [
  'pause',
  'duration',
  'idle-active',
  'volume',
  'mute',
  'audio-params',
  'audio-codec-name',
  'media-title',
  'metadata',
  'time-pos',
  'playback-restart',
  'seeking'
] as const;

export type ObservableProperty = (typeof TARGET_PROPS)[number];

const EMPTY_STATUS: InternalStatus = {
  volume: 0,
  time: 0,
  mute: false,
  idle: true,
  paused: true,
  isSeeking: false,
  state: 'stopped'
};

export class MPVStatusProvider extends PlayerStatusProvider<MPVStatus> {
  #currentStatus: InternalStatus;
  // Track time separately - include in getStatus() / emit('status'...) / emit('time'...)
  #time: number;
  #isObserving: boolean;
  #command: MPVCommandSender;
  #logger: Logger;

  constructor(options: MPVStatusProviderOptions) {
    super();
    this.#command = options.commandSender;
    this.#logger = options.logger;
    this.#isObserving = false;
    this.#currentStatus = {
      ...EMPTY_STATUS
    };
    this.#time = 0;
  }

  async start() {
    if (this.#isObserving) {
      return;
    }
    await Promise.all(
      TARGET_PROPS.map((prop, i) => this.#observe(prop, i + 1))
    );
    this.#isObserving = true;
  }

  #observe(property: ObservableProperty, subcriptionId: number) {
    return this.#command.send('observe_property', subcriptionId, property);
  }

  processParsedIncomingData(data: any[]) {
    const propertyChangeEvents = data.reduce<PropertyChangeEvent[]>(
      (result, res) => {
        if (res['event'] === 'property-change') {
          const { name: prop, id: subscriptionId, data } = res;
          if (
            typeof subscriptionId === 'number' &&
            this.#isObservableProperty(prop) &&
            TARGET_PROPS[subscriptionId - 1] === prop
          ) {
            result.push({
              subscriptionId,
              prop,
              data
            });
          }
        }
        return result;
      },
      []
    );

    if (propertyChangeEvents.length === 0) {
      return;
    }

    const timePosEvent = propertyChangeEvents
      .filter(({ prop }) => prop === 'time-pos')
      .at(-1);
    if (timePosEvent) {
      const oldTime = this.#time;
      this.#time =
        typeof timePosEvent.data === 'number' ? timePosEvent.data : 0;
      if (this.#time !== oldTime) {
        this.emit('time', this.#time);
      }
    }

    const playbackRestart = propertyChangeEvents.some(
      ({ prop }) => prop === 'playback-restart'
    );

    const seekingEvents = propertyChangeEvents.filter(
      ({ prop }) => prop === 'seeking'
    );
    let hasFinishedSeeking = false;
    for (const { data: isSeeking } of seekingEvents) {
      if (typeof isSeeking === 'boolean') {
        if (isSeeking) {
          this.#currentStatus.isSeeking = true;
        } else if (this.#currentStatus.isSeeking) {
          // was seeking - now finished
          this.#currentStatus.isSeeking = false;
          hasFinishedSeeking = true;
          break;
        }
      }
    }

    const forceEmit = playbackRestart || hasFinishedSeeking;

    const handledProps: ObservableProperty[] = [
      'time-pos',
      'playback-restart',
      'seeking'
    ];
    const updateStatusEvents = propertyChangeEvents.filter(
      ({ prop }) => !handledProps.includes(prop)
    );

    let statusChanged = false;
    if (updateStatusEvents.length > 0) {
      this.#logger.info(
        `Status update -> property-change events: ${JSON.stringify(updateStatusEvents)}`
      );
      const newStatus = _.clone(this.#currentStatus);
      for (const event of updateStatusEvents) {
        this.#updateStatus(event['prop'], event['data'], newStatus);
      }
      if (!_.isEqual(newStatus, this.#currentStatus)) {
        // Update 'state' based on 'idle' and 'paused' values
        if (newStatus.idle) {
          newStatus.state = 'stopped';
        } else {
          newStatus.state = newStatus.paused ? 'paused' : 'playing';
        }
        if (!newStatus.title) {
          newStatus.title = newStatus.displayTitle;
        }
        this.#currentStatus = newStatus;
        statusChanged = true;
      }
    }

    if (forceEmit || statusChanged) {
      this.emit('status', this.getStatus());
    }
  }

  getStatus(): MPVStatus {
    const result = _.clone(this.#currentStatus) as any;
    delete result.displayTitle;
    delete result.idle;
    delete result.paused;
    delete result.isSeeking;
    result.time = this.#time;
    return result;
  }

  #isObservableProperty(prop: string): prop is ObservableProperty {
    return TARGET_PROPS.includes(prop as any);
  }

  #updateStatus(
    prop: ObservableProperty,
    data: unknown,
    status: InternalStatus
  ) {
    switch (prop) {
      case 'volume': {
        if (typeof data === 'number') {
          status.volume = data;
        }
        break;
      }
      case 'duration': {
        if (typeof data === 'number') {
          status.duration = data;
        } else {
          status.duration = undefined;
        }
        break;
      }
      case 'mute': {
        status.mute = typeof data === 'boolean' ? data : false;
        break;
      }
      case 'idle-active': {
        status.idle = typeof data === 'boolean' ? data : true;
        break;
      }
      case 'pause': {
        status.paused = typeof data === 'boolean' ? data : true;
        break;
      }
      case 'audio-params': {
        const { samplerate, channels, bitdepth } = this.#parseAudioParams(data);
        status.samplerate = samplerate;
        status.channels = channels;
        status.bitdepth = bitdepth;
        break;
      }
      case 'audio-codec-name': {
        if (typeof data === 'string') {
          status.trackType = data;
        } else {
          status.trackType = undefined;
        }
        break;
      }
      case 'media-title': {
        if (typeof data === 'string') {
          status.displayTitle = data;
        } else {
          status.displayTitle = undefined;
        }
        break;
      }
      case 'metadata': {
        const { title, artist, album, bitrate } = this.#parseMetadata(data);
        status.title = title;
        status.artist = artist;
        status.album = album;
        status.bitrate = bitrate;
        break;
      }
      default:
        this.#logger.warn(
          `Unhandled property-change event "${prop}": ${JSON.stringify(data)}`
        );
        return;
    }
  }

  async unobserve() {
    if (!this.#isObserving) {
      return;
    }
    await Promise.all(
      TARGET_PROPS.map((_, i) => this.#command.send('unobserve_property', i))
    );
    this.#isObserving = false;
  }

  async reset(killed = false) {
    // If process killed, then don't unobserve() as that would definitely fail.
    if (!killed) {
      await this.unobserve();
    } else {
      this.#isObserving = false;
    }
    this.#currentStatus = {
      ...EMPTY_STATUS
    };
  }

  #parseAudioParams(data: any) {
    if (!data || typeof data !== 'object') {
      return {};
    }
    // Example data: {"samplerate":44100,"channel-count":2,"channels":"stereo","hr-channels":"stereo","format":"floatp","bitrate": 192000}
    try {
      const samplerateValue = data['samplerate'] || undefined;
      const samplerate =
        typeof samplerateValue === 'number' ?
          `${samplerateValue / 1000} kHz`
        : samplerateValue;
      const channels = data['channel-count'] || undefined;
      // Bit depth may not be accurate, particularly "32-bit" which could actually be 24-bit but padded by mpv
      let bitdepth: string | undefined = undefined;
      switch (data['format']) {
        case 'u8':
        case 's8':
          bitdepth = '8-bit';
          break;
        case 's16':
          bitdepth = '16-bit';
          break;
        case 's32':
          bitdepth = '32-bit';
          break;
      }
      return {
        samplerate,
        channels,
        bitdepth
      };
    } catch {
      return {};
    }
  }

  #parseMetadata(data: any) {
    if (!data || typeof data !== 'object') {
      return {};
    }

    const bitrateValue = data['bitrate'];
    let bitrate: string | undefined = undefined;
    if (typeof bitrateValue === 'string') {
      const bitrateNumber = Number(bitrateValue);
      if (!isNaN(bitrateNumber)) {
        bitrate = `${bitrateNumber / 1000} kbps`;
      } else {
        bitrate = bitrateValue;
      }
    }

    return {
      title: data['title'],
      artist: data['artist'],
      album: data['album'],
      bitrate
    };
  }
}
