import _ from 'lodash';
import { type VlcStatus } from "vlc-client/dist/Types";

export class VLCHelper {

  static getTrackInfo(status: VlcStatus) {
    if (!status.information) {
      return undefined;
    }
    const meta = status.information.category.meta;
    return {
      title: this.#getTitle(status),
      artist: meta.artist,
      album: meta.album,
      duration: status.length,
      ...this.#getAudioInfo(status)
    }
  }

  static #getTitle(status: VlcStatus): string | undefined {
    if (status.information.title && typeof status.information.title === 'string') {
      return status.information.title;
    }
    if (status.information.titles) {
      const title = status.information.titles.find(t => t && typeof t === 'string');
      if (title) {
        return title;
      }
    }
    const meta = status.information.category.meta;
    return meta.title || meta.filename || undefined;
  }

  static #getAudioInfo(status: VlcStatus) {
    const category = status.information?.category;
    if (category) {
      for (const cat of Object.values(category)) {
        if (_.get(cat, 'type') === 'audio') {
          const channels = _.get(cat, 'Channels');
          return {
            trackType: _.get(cat, 'Codec'),
            samplerate: _.get(cat, 'Sample_rate'),
            bitrate: _.get(cat, 'Bitrate'),
            bitdepth: _.get(cat, 'Bits_per_sample'),
            channels: channels === 'Stereo' ? 2 :
                      channels === 'Mono' ? 1 :
                      channels ? parseInt(channels, 10) : undefined
          };
        }
      }
    }
    return {
      trackType: undefined,
      samplerate: undefined,
      bitrate: undefined,
      bitdepth: undefined,
      channels: undefined
    };
  }
}