/*  inline demuxer.
 *   probe fragments and instantiate appropriate demuxer depending on content type (TSDemuxer, AACDemuxer, ...)
 */

import Event from '../events';
import { ErrorTypes, ErrorDetails } from '../errors';
import Decrypter from '../crypt/decrypter';
import AACDemuxer from '../demux/aacdemuxer';
import MP4Demuxer from '../demux/mp4demuxer';
import TSDemuxer from '../demux/tsdemuxer';
import MP3Demuxer from '../demux/mp3demuxer';
import MP4Remuxer from '../remux/mp4-remuxer';
import PassThroughRemuxer from '../remux/passthrough-remuxer';

class DemuxerInline {

  constructor(observer, typeSupported, config, vendor) {
    this.observer = observer;
    this.typeSupported = typeSupported;
    this.config = config;
    this.vendor = vendor;
  }

  destroy() {
    var demuxer = this.demuxer;
    if (demuxer) {
      demuxer.destroy();
    }
  }

  push(data, decryptdata, initSegment, audioCodec, videoCodec, timeOffset, discontinuity, trackSwitch, contiguous, duration, accurateTimeOffset, defaultInitPTS) {
    if ((data.byteLength > 0) && (decryptdata != null) && (decryptdata.key != null) && (decryptdata.method === 'AES-128')) {
      let decrypter = this.decrypter;
      if (decrypter == null) {
        decrypter = this.decrypter = new Decrypter(this.observer, this.config);
      }
      var localthis = this;
      // performance.now() not available on WebWorker, at least on Safari Desktop
      var startTime;
      try {
        startTime = performance.now();
      } catch (error) {
        startTime = Date.now();
      }
      decrypter.decrypt(data, decryptdata.key.buffer, decryptdata.iv.buffer, function (decryptedData) {
        var endTime;
        try {
          endTime = performance.now();
        } catch (error) {
          endTime = Date.now();
        }
        localthis.observer.trigger(Event.FRAG_DECRYPTED, { stats: { tstart: startTime, tdecrypt: endTime } });
        localthis.pushDecrypted(new Uint8Array(decryptedData), decryptdata, new Uint8Array(initSegment), audioCodec, videoCodec, timeOffset, discontinuity, trackSwitch, contiguous, duration, accurateTimeOffset, defaultInitPTS);
      });
    } else {
      this.pushDecrypted(new Uint8Array(data), decryptdata, new Uint8Array(initSegment), audioCodec, videoCodec, timeOffset, discontinuity, trackSwitch, contiguous, duration, accurateTimeOffset, defaultInitPTS);
    }
  }

  pushDecrypted(data, decryptdata, initSegment, audioCodec, videoCodec, timeOffset, discontinuity, trackSwitch, contiguous, duration, accurateTimeOffset, defaultInitPTS) {
    var demuxer = this.demuxer;
    if (!demuxer ||
      // in case of continuity change, we might switch from content type (AAC container to TS container for example)
      // so let's check that current demuxer is still valid
      (discontinuity && !this.probe(data))) {
      const observer = this.observer;
      const typeSupported = this.typeSupported;
      const config = this.config;
      const muxConfig = [{ demux: TSDemuxer, remux: MP4Remuxer },
      { demux: AACDemuxer, remux: MP4Remuxer },
      { demux: MP3Demuxer, remux: MP4Remuxer },
      { demux: MP4Demuxer, remux: PassThroughRemuxer }];

      // probe for content type
      let tsMatch = TSDemuxer.probe(data);
      let aacMatch = AACDemuxer.probe(data);
      let mp3Match = MP3Demuxer.probe(data);
      let mp4Match = MP4Demuxer.probe(data);

      let h264Pattern = /^avc/i;
      let aacPattern = /^mp4a(\.40\.2|\.40\.5|\.40\.29)/i;
      let mp3Pattern = /^mp4a.40.34/i;

      /* prioritize demuxer:
       * if tsMatch && h264Pattern  => TSDemuxer
       * if aacMatch && aacPattern => AACDemuxer
       * if mp3Match && mp3Pattern => MP3Demuxer
       * if mp4Match && h264Pattern => MP4Demuxer
       * if no codec info in Manifest, use fallback order : AAC/MP3/TS/MP4
       */
      let mux;
      if (tsMatch && videoCodec && h264Pattern.test(videoCodec)) {
        mux = muxConfig[0];
      } else if (aacMatch && audioCodec && aacPattern.test(audioCodec)) {
        mux = muxConfig[1];
      } else if (mp3Match && audioCodec && mp3Pattern.test(audioCodec)) {
        mux = muxConfig[2];
      } else if (mp4Match && videoCodec && h264Pattern.test(videoCodec)) {
        mux = muxConfig[3];
      } else if (aacMatch) {
        mux = muxConfig[1];
      } else if (mp3Match) {
        mux = muxConfig[2];
      } else if (tsMatch) {
        mux = muxConfig[0];
      } else if (mp4Match) {
        mux = muxConfig[3];
      }
      if (mux) {
        const probe = mux.demux.probe;
        const remuxer = this.remuxer = new mux.remux(observer, config, typeSupported, this.vendor);
        demuxer = new mux.demux(observer, remuxer, config, typeSupported);
        this.probe = probe;
      }
      if (!demuxer) {
        observer.trigger(Event.ERROR, { type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.FRAG_PARSING_ERROR, fatal: true, reason: 'no demux matching with content found' });
        return;
      }
      this.demuxer = demuxer;
    }
    const remuxer = this.remuxer;

    if (discontinuity || trackSwitch) {
      demuxer.resetInitSegment(initSegment, audioCodec, videoCodec, duration);
      remuxer.resetInitSegment();
    }
    if (discontinuity) {
      demuxer.resetTimeStamp(defaultInitPTS);
      remuxer.resetTimeStamp(defaultInitPTS);
    }
    if (typeof demuxer.setDecryptData === 'function') {
      demuxer.setDecryptData(decryptdata);
    }
    demuxer.append(data, timeOffset, contiguous, accurateTimeOffset);
  }
}

export default DemuxerInline;
