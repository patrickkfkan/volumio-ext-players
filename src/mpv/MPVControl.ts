import { type MPVStatusProvider, type MPVStatus } from "./MPVStatusProvider";
import { type MPVServiceContext } from "./MPVService";
import { PlayerControl } from "../common/PlayerControl";
import { type MPVCommandSender } from "./CommandSender";
import { ensureError } from "../common/Util";

export interface MPVControlOptions {
  context: MPVServiceContext;
  statusProvider: MPVStatusProvider;
  commandSender: MPVCommandSender;
}

export type MPVSeekMode =
  | "absolute"
  | "relative"
  | "absolute+exact"
  | "relative+exact"
  | "keyframe"
  | "percent";


export class MPVControl extends PlayerControl<MPVStatus> {
  #statusProvider: MPVStatusProvider;
  #command: MPVCommandSender;

  constructor(options: MPVControlOptions) {
    super({
      statusProvider: options.statusProvider,
      volumio: options.context.volumio
    });
    this.#statusProvider = options.statusProvider;
    this.#command = options.commandSender;
  }

  #resolveOnStatus(
    resolve: () => void,
    reject: (err: Error) => void,
    condition: (status: MPVStatus) => boolean,
    timeout = 30000
  ) {
    const listener = (status: MPVStatus) => {
      if (condition(status)) {
        this.#statusProvider.off('status', listener);
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      this.#statusProvider.off('status', listener);
      reject(Error('Operation timeout'));
    }, timeout);

    this.#statusProvider.on('status', listener);
  }

  async doPlayFile(uri: string) {
    return await new Promise<void>((resolve, reject) => {
      this.#resolveOnStatus(
        resolve,
        reject,
        (status) => status.state === 'playing'
      );
      // Send unpause command right after loadfile.
      // If we don't do this and we sent a pause command previously, 
      // the loaded file will remain in paused state.
      this.#command.send('loadfile', uri, 'replace')
        .then(() => this.#command.send('set_property', 'pause', false))
        .catch((error: unknown) => reject(ensureError(error)));
    });
  }

  async doPlay() {
    return await new Promise<void>((resolve, reject) => {
      this.#resolveOnStatus(
        resolve,
        reject,
        (status) => status.state === 'playing'
      );
      this.#command.send('set_property', 'pause', false)
        .catch((error: unknown) => reject(ensureError(error)));
    });
  }

  async doPause() {
    return await new Promise<void>((resolve, reject) => {
      this.#resolveOnStatus(
        resolve,
        reject,
        (status) => status.state === 'paused'
      );
      this.#command.send('set_property', 'pause', true)
        .catch((error: unknown) => reject(ensureError(error)));
    });
  }

  async doStop() {
    return await new Promise<void>((resolve, reject) => {
      this.#resolveOnStatus(
        resolve,
        reject,
        (status) => status.state === 'stopped'
      );
      this.#command.send('stop')
        .catch((error: unknown) => reject(ensureError(error)));
    });
  }

  doSeek(position: number) {
    return this.#command.send('seek', position, 'absolute');
  }

  doSetVolume(volume: number) {
    return this.#command.send('set_property', 'volume', volume);
  }

  doSetRepeatSingle(value: boolean) {
    return this.#command.send('set_property', 'loop-file', value ? 'inf' : 'no');
  }
}