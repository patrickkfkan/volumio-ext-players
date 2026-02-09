import { type PlayerStatus, type PlayerStatusProvider as PlayerStatusProvider } from "./PlayerStatusProvider";
import { kewToJSPromise } from "./Util";
import { type VolumioContext } from "./VolumioContext";

export interface PlayerControlOptions<S extends PlayerStatus> {
  volumio?: VolumioContext;
  statusProvider: PlayerStatusProvider<S>;
}

export abstract class PlayerControl<S extends PlayerStatus> {

  #volumio?: VolumioContext;
  #statusProvider: PlayerStatusProvider<S>;
  #previousTimer: NodeJS.Timeout | null = null;
  #isStopping = false;

  constructor(options: PlayerControlOptions<S>) {
    this.#volumio = options.volumio;
    this.#statusProvider = options.statusProvider;
  }
  
  abstract doPlayFile(uri: string): Promise<void>;
  abstract doPlay(): Promise<void>;
  abstract doPause(): Promise<void>;
  abstract doStop(): Promise<void>;
  abstract doSetVolume(volume: number): Promise<void>;
  abstract doSeek(position: number): Promise<void>;
  abstract doSetRepeatSingle(value: boolean): Promise<void>;

  #getPlayerState() {
    return this.#statusProvider.getStatus().state;
  }

  async playFile(uri: string) {
    this.clearPreviousTimer();
    return await this.doPlayFile(uri);
  }

  async play() {
    this.clearPreviousTimer();
    if (this.#getPlayerState() === 'paused') {
      return this.doPlay();
    }
  }

  async pause() {
    this.clearPreviousTimer();
    if (this.#getPlayerState() === 'playing') {
      return this.doPause();
    }
  }

  async stop() {
    this.clearPreviousTimer();
    if (this.#isStopping) {
      return;
    }
    if (this.#getPlayerState() !== 'stopped') {
      if (this.#volumio) {
        const sm = this.#volumio.statemachine;
        // Do what statemachine does
        sm.currentStatus = 'stop'; // Important - stops Volumio from automatically advancing to next track
        sm.currentSeek = 0;
        sm.stopPlaybackTimer();
        sm.updateTrackBlock();
      }
      this.#isStopping = true;
      try {
        return await this.doStop();
      } finally {
        this.#isStopping = false;
      }
    }
  }

  async setVolume(volume: number) {
    this.clearPreviousTimer();
    return await this.doSetVolume(volume);
  }

  async seek(position: number) {
    this.clearPreviousTimer();
    return await this.doSeek(position);
  }

  async setRepeatSingle(value: boolean) {
    this.clearPreviousTimer();
    return await this.doSetRepeatSingle(value);
  }

  isStopping() {
    return this.#isStopping;
  }

  protected clearPreviousTimer() {
    if (this.#previousTimer) {
      clearTimeout(this.#previousTimer);
      this.#previousTimer = null;
    }
  }

  async previous() {
    const op = !this.#previousTimer && this.#getPlayerState() !== 'stopped' ? 'rewind' : 'previousTrack';
    this.clearPreviousTimer();
    if (!this.#volumio) {
      return;
    }
    switch (op) {
      case 'rewind': {
        const seek = this.seek(0);
        this.#previousTimer = setTimeout(() => {
          this.#previousTimer = null;
        }, 3000);
        return await seek;
      }
      case 'previousTrack': {
        const sm = this.#volumio.statemachine;
        await this.stop();
        if (sm.currentRandom === true) {
          sm.currentPosition = sm.randomQueue.prev();
        }
        else if (sm.currentPosition > 0) {
          sm.currentPosition--;
        }
        await kewToJSPromise(sm.play());
        await kewToJSPromise(sm.updateTrackBlock());
      }
    }
  }

  async next() {
    this.clearPreviousTimer();
    if (!this.#volumio) {
      return;
    }
    // Do what statemachine does
    const sm = this.#volumio.statemachine;
    await this.stop();
    sm.currentPosition = sm.getNextIndex();
    await kewToJSPromise(sm.play());
    await kewToJSPromise(sm.updateTrackBlock());
  }
}