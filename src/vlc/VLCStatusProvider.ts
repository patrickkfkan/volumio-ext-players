import _ from 'lodash';
import type * as VLC from 'vlc-client';
import { VLCHelper } from './VLCHelper';
import {
  type PlayerStatus,
  PlayerStatusProvider
} from '../common/PlayerStatusProvider';
import { type Logger } from '../common/ServiceContext';
import { getErrorMessage } from '../common/Util';

export interface VLCStatusProviderOptions {
  pollInterval?: number;
  client: VLC.Client;
  logger: Logger;
}

export type VLCStatus = PlayerStatus;

const DEFAULT_OPTIONS = {
  interval: 500
} as const;

const EMPTY_STATUS: VLCStatus = {
  volume: 0,
  time: 0,
  mute: false,
  state: 'stopped'
};

export class VLCStatusProvider extends PlayerStatusProvider<VLCStatus> {
  #options: VLCStatusProviderOptions;
  #logger: Logger;
  #pollTimer: NodeJS.Timeout | null = null;
  // Track time separately - include in getStatus() / emit('status'...) / emit('time'...)
  #time: number;
  #currentStatus: VLCStatus;
  #pollingStatus: 'started' | 'stopped';

  constructor(options: VLCStatusProviderOptions) {
    super();
    this.#options = {
      ...DEFAULT_OPTIONS,
      ...options
    };
    this.#logger = options.logger;
    this.#currentStatus = {
      ...EMPTY_STATUS
    };
    this.#time = 0;
    this.#pollingStatus = 'stopped';
  }

  startPolling() {
    if (this.#pollingStatus === 'started') {
      return;
    }
    const setPollTimer = () => {
      this.#pollTimer = setTimeout(() => {
        void (async () => {
          try {
            await this.#getAndEmitStatus();
          } catch (error) {
            this.#logger.error(`Poll error: ${getErrorMessage(error)}`);
          }
          if (this.#pollingStatus === 'started') {
            setPollTimer();
          }
        })();
      }, this.#options.pollInterval);
    };
    this.#pollingStatus = 'started';
    setPollTimer();
  }

  stopPolling() {
    if (this.#pollingStatus === 'stopped') {
      return;
    }
    this.#pollingStatus = 'stopped';
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  reset() {
    this.stopPolling();
    this.#currentStatus = {
      ...EMPTY_STATUS
    };
  }

  async #getAndEmitStatus() {
    const client = this.#options.client;
    const status = await client.status();
    const { volume, time, state } = status;
    // Seeked backwards or song repeated after reaching end (time returns to 0)
    // In this case, we must emit 'status' event.
    const timeDecremented = time < this.#time;

    // Store time, which we track separately
    if (this.#time !== time) {
      this.#time = time;
      this.emit('time', time);
    }

    if (
      !timeDecremented &&
      this.#currentStatus.state === state &&
      state !== 'playing'
    ) {
      // stopped or paused
      return;
    }

    const newStatus = {
      ...this.#currentStatus,
      ...VLCHelper.getTrackInfo(status),
      volume,
      state: state as VLCStatus['state'],
      mute: volume === 0
    };
    if (!timeDecremented && _.isEqual(this.#currentStatus, newStatus)) {
      return;
    }

    this.#currentStatus = newStatus;
    this.emit('status', this.getStatus());
  }

  getStatus(): VLCStatus {
    return {
      ...this.#currentStatus,
      time: this.#time
    };
  }
}
