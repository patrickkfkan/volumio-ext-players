import semver from 'semver';
import { type MPVStatusProvider, type MPVStatus } from './MPVStatusProvider';
import { type MPVServiceContext } from './MPVService';
import { PlayerControl } from '../common/PlayerControl';
import { type MPVCommandSender } from './CommandSender';
import { ensureError } from '../common/Util';
import { type Logger } from '../common/ServiceContext';

export interface MPVControlOptions {
  mpvVersion: string | null;
  context: MPVServiceContext;
  statusProvider: MPVStatusProvider;
  commandSender: MPVCommandSender;
  logger: Logger;
}

export type MPVSeekMode =
  | 'absolute'
  | 'relative'
  | 'absolute+exact'
  | 'relative+exact'
  | 'keyframe'
  | 'percent';

export class MPVControl extends PlayerControl<MPVStatus> {
  #statusProvider: MPVStatusProvider;
  #command: MPVCommandSender;
  #loadFileRequiresIndexArg: boolean = false;

  constructor(options: MPVControlOptions) {
    super({
      statusProvider: options.statusProvider,
      volumio: options.context.volumio
    });
    this.#statusProvider = options.statusProvider;
    this.#command = options.commandSender;
    if (options.mpvVersion) {
      this.#loadFileRequiresIndexArg = semver.satisfies(
        options.mpvVersion,
        '>=0.38.0'
      );
    } else {
      options.logger.warn(
        `No mpv version available - assume loadFileCmdRequiresIndexArg is "${this.#loadFileRequiresIndexArg}"`
      );
    }
  }

  #resolveOnStatus(
    resolve: () => void,
    reject: (err: Error) => void,
    condition: (status: MPVStatus) => boolean,
    cmd?: string,
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
      reject(Error(`Operation timeout${cmd ? `: ${cmd}` : ''}`));
    }, timeout);

    this.#statusProvider.on('status', listener);
  }

  async doPlayFile(uri: string, start: number) {
    return await new Promise<void>((resolve, reject) => {
      this.#resolveOnStatus(
        resolve,
        reject,
        (status) =>
          status.state === 'playing' && (start === 0 || status.time >= start),
        `playFile "${uri}"; start=${start}`
      );
      const cmd =
        this.#loadFileRequiresIndexArg ?
          this.#command.send('loadfile', uri, 'replace', 0, `start=${start}`)
        : this.#command.send('loadfile', uri, 'replace', `start=${start}`);
      // Send unpause command right after loadfile.
      // If we don't do this and we sent a pause command previously,
      // the loaded file will remain in paused state.
      cmd
        .then(() => this.#command.send('set_property', 'pause', false))
        .catch((error: unknown) => reject(ensureError(error)));
    });
  }

  async doPlay() {
    return await new Promise<void>((resolve, reject) => {
      this.#resolveOnStatus(
        resolve,
        reject,
        (status) => status.state === 'playing',
        `play`
      );
      this.#command
        .send('set_property', 'pause', false)
        .catch((error: unknown) => reject(ensureError(error)));
    });
  }

  async doPause() {
    return await new Promise<void>((resolve, reject) => {
      this.#resolveOnStatus(
        resolve,
        reject,
        (status) => status.state === 'paused',
        'pause'
      );
      this.#command
        .send('set_property', 'pause', true)
        .catch((error: unknown) => reject(ensureError(error)));
    });
  }

  async doStop() {
    return await new Promise<void>((resolve, reject) => {
      this.#resolveOnStatus(
        resolve,
        reject,
        (status) => status.state === 'stopped',
        'stop'
      );
      this.#command
        .send('stop')
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
    return this.#command.send(
      'set_property',
      'loop-file',
      value ? 'inf' : 'no'
    );
  }
}
