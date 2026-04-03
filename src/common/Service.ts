import EventEmitter from 'events';
import { type PlayerStatus } from './PlayerStatusProvider';
import { type UnsetVolatileInfo, type TrackInfo } from './VolumioStateManager';

export abstract class Service<S extends PlayerStatus> extends EventEmitter {
  abstract start(): Promise<void>;

  abstract quit(): Promise<void>;

  abstract isActive(): boolean;

  abstract getStatus(): S | null;

  /**
   *
   * @param track
   * @param start Position from which to start playback (seconds)
   */
  abstract play(track: TrackInfo, start?: number): Promise<void>;

  abstract pause(): Promise<void>;

  abstract stop(): Promise<void>;

  abstract resume(): Promise<void>;

  abstract next(): Promise<void>;

  abstract previous(): Promise<void>;

  abstract setRandom(value: boolean): void;

  abstract setRepeat(value: boolean, repeatSingle: boolean): Promise<void>;

  abstract pushState(): void;

  /**
   *
   * @param position Position to seek to in seconds
   */
  abstract seek(position: number): Promise<void>;

  protected forwardStatusEvent(status: S) {
    this.emit('status', status);
  }

  protected forwardVolatileEvent(eventName: 'setVolatile'): void;
  protected forwardVolatileEvent(
    eventName: 'unsetVolatile',
    info: UnsetVolatileInfo
  ): void;
  protected forwardVolatileEvent(
    eventName: 'setVolatile' | 'unsetVolatile',
    info?: UnsetVolatileInfo
  ) {
    switch (eventName) {
      case 'setVolatile':
        this.emit('setVolatile');
        break;
      case 'unsetVolatile':
        this.emit('unsetVolatile', info!);
        break;
    }
  }

  emit(eventName: 'setVolatile'): boolean;
  emit(eventName: 'unsetVolatile', info: UnsetVolatileInfo): boolean;
  emit(
    eventName: 'close',
    code: number | null,
    signal: NodeJS.Signals | null
  ): boolean;
  emit(eventName: 'status', status: S): boolean;
  emit<K>(eventName: string | symbol, ...args: any[]): boolean {
    return super.emit(eventName, ...args);
  }

  on(eventName: 'setVolatile', listener: () => void): this;
  on(
    eventName: 'unsetVolatile',
    listener: (info: UnsetVolatileInfo) => void
  ): this;
  on(
    eventName: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  on(eventName: 'status', listener: (status: S) => void): this;
  on<K>(eventName: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(eventName, listener);
  }

  once(eventName: 'setVolatile', listener: () => void): this;
  once(
    eventName: 'unsetVolatile',
    listener: (info: UnsetVolatileInfo) => void
  ): this;
  once(
    eventName: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  once(eventName: 'status', listener: (status: S) => void): this;
  once<K>(
    eventName: string | symbol,
    listener: (...args: any[]) => void
  ): this {
    return super.once(eventName, listener);
  }

  off(eventName: 'setVolatile', listener: () => void): this;
  off(
    eventName: 'unsetVolatile',
    listener: (info: UnsetVolatileInfo) => void
  ): this;
  off(
    eventName: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  off(eventName: 'status', listener: (status: S) => void): this;
  off<K>(eventName: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(eventName, listener);
  }
}
