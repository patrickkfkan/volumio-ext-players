import EventEmitter from "events";
import { type PlayerStatus } from "./PlayerStatusProvider";
import { type TrackInfo } from "./VolumioStateManager";

export abstract class Service<S extends PlayerStatus> extends EventEmitter {
  abstract start(): Promise<void>;

  abstract quit(): Promise<void>;

  abstract isActive(): boolean;

  abstract getStatus(): S | null;

  abstract play(track: TrackInfo): Promise<void>;

  abstract pause(): Promise<void>;

  abstract stop(): Promise<void>;

  abstract resume(): Promise<void>;

  abstract next(): Promise<void>;

  abstract previous(): Promise<void>;

  abstract setRandom(value: boolean): void;

  abstract setRepeat(value: boolean, repeatSingle: boolean): Promise<void>;

  /**
   * 
   * @param position Position to seek to in seconds
   */
  abstract seek(position: number): Promise<void>;

  emit(eventName: 'close', code: number | null, signal: NodeJS.Signals | null): boolean;
  emit(eventName: 'status', status: S): boolean;
  emit<K>(eventName: string | symbol, ...args: any[]): boolean {
    return super.emit(eventName, ...args);
  }

  on(eventName: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(eventName: 'status', listener: (status: S) => void): this;
  on<K>(eventName: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(eventName, listener);
  }

  once(eventName: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(eventName: 'status', listener: (status: S) => void): this;
  once<K>(eventName: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(eventName, listener);
  }

  off(eventName: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(eventName: 'status', listener: (status: S) => void): this;
  off<K>(eventName: string | symbol, listener: (...args: any[]) => void): this {
      return super.off(eventName, listener);
  }
}