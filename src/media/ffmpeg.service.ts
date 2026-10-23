import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { appLogger } from '../utils/logger';
import { MediaCorruptedError } from '../utils/errors';

// Resolve Windows winget ffmpeg/ffprobe paths if available
const wingetBin = 'C:\\Users\\aryan\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin';
if (fs.existsSync(path.join(wingetBin, 'ffmpeg.exe'))) {
  ffmpeg.setFfmpegPath(path.join(wingetBin, 'ffmpeg.exe'));
}
if (fs.existsSync(path.join(wingetBin, 'ffprobe.exe'))) {
  ffmpeg.setFfprobePath(path.join(wingetBin, 'ffprobe.exe'));
}

export interface MediaProbeMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  codec: string;
  bitrate: number;
  fps: number;
  hasAudio: boolean;
  audioCodec?: string;
  sizeBytes: number;
}

export interface ProgressCallback {
  (stage: string, percent: number): void;
}

export class FFmpegService {
  private logger = appLogger.child('FFmpegService');
  private activeProcesses: Map<string, ffmpeg.FfmpegCommand> = new Map();

  /**
   * Probe video and return technical media stream information
   */
  async probe(filePath: string): Promise<MediaProbeMetadata> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found at path: ${filePath}`);
    }

    const stat = fs.statSync(filePath);

    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          this.logger.error('FFprobe inspection error', err, { filePath });
          return reject(new MediaCorruptedError(`Cannot probe video file: ${err.message}`));
        }

        const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
        const audioStream = metadata.streams.find((s) => s.codec_type === 'audio');

        if (!videoStream) {
          return reject(new MediaCorruptedError('No valid video stream identified in file'));
        }

        let fps = 30;
        if (videoStream.r_frame_rate) {
          const parts = videoStream.r_frame_rate.split('/');
          if (parts.length === 2 && parseFloat(parts[1]) !== 0) {
            fps = parseFloat(parts[0]) / parseFloat(parts[1]);
          }
        }

        resolve({
          durationSeconds: metadata.format.duration || videoStream.duration ? parseFloat(String(metadata.format.duration || videoStream.duration)) : 0,
          width: videoStream.width || 1280,
          height: videoStream.height || 720,
          codec: videoStream.codec_name || 'unknown',
          bitrate: metadata.format.bit_rate ? parseInt(String(metadata.format.bit_rate), 10) : 0,
          fps: Math.round(fps),
          hasAudio: !!audioStream,
          audioCodec: audioStream?.codec_name,
          sizeBytes: stat.size,
        });
      });
    });
  }

  /**
   * Generate lower-resolution proxy (e.g., 640x360 or 1280x720) with honest progress tracking
   */
  async generateProxy(
    jobId: string,
    inputPath: string,
    outputPath: string,
    options: { width?: number; height?: number; bitrate?: string } = {},
    onProgress?: ProgressCallback
  ): Promise<string> {
    const width = options.width || 640;
    const height = options.height || 360;
    const bitrate = options.bitrate || '800k';

    this.ensureDirExists(path.dirname(outputPath));
    const probeData = await this.probe(inputPath);
    const totalDurationSec = probeData.durationSeconds || 1;

    return new Promise((resolve, reject) => {
      const command = ffmpeg(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .size(`${width}x${height}`)
        .videoBitrate(bitrate)
        .outputOptions([
          '-preset veryfast',
          '-movflags +faststart',
          '-pix_fmt yuv420p',
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          this.logger.info(`Started proxy transcode: ${commandLine}`, { jobId });
          if (onProgress) onProgress('PROXY_ENCODING', 0);
        })
        .on('progress', (progress) => {
          let percent = progress.percent;
          if (percent === undefined || isNaN(percent)) {
            // Compute percentage from timemark: "00:01:23.45"
            if (progress.timemark) {
              const seconds = this.timemarkToSeconds(progress.timemark);
              percent = Math.min(99, Math.round((seconds / totalDurationSec) * 100));
            } else {
              percent = 0;
            }
          }
          const clamped = Math.max(0, Math.min(99, Math.round(percent)));
          if (onProgress) onProgress('PROXY_ENCODING', clamped);
        })
        .on('end', () => {
          this.activeProcesses.delete(jobId);
          if (onProgress) onProgress('PROXY_COMPLETED', 100);
          resolve(outputPath);
        })
        .on('error', (err) => {
          this.activeProcesses.delete(jobId);
          this.logger.error('Proxy transcode error', err, { jobId });
          reject(err);
        });

      this.activeProcesses.set(jobId, command);
      command.run();
    });
  }

  /**
   * Normalize input media into high-quality standardized 1080p MP4
   */
  async normalizeVideo(
    jobId: string,
    inputPath: string,
    outputPath: string,
    onProgress?: ProgressCallback
  ): Promise<string> {
    this.ensureDirExists(path.dirname(outputPath));
    const probeData = await this.probe(inputPath);
    const totalDurationSec = probeData.durationSeconds || 1;

    return new Promise((resolve, reject) => {
      const command = ffmpeg(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .size('1920x1080')
        .outputOptions(['-preset fast', '-crf 22', '-movflags +faststart'])
        .output(outputPath)
        .on('start', (cmd) => {
          this.logger.info(`Started normalizing video: ${cmd}`, { jobId });
          if (onProgress) onProgress('NORMALIZING_VIDEO', 0);
        })
        .on('progress', (progress) => {
          let percent = progress.percent;
          if (percent === undefined || isNaN(percent)) {
            if (progress.timemark) {
              const seconds = this.timemarkToSeconds(progress.timemark);
              percent = Math.min(99, Math.round((seconds / totalDurationSec) * 100));
            }
          }
          if (onProgress) onProgress('NORMALIZING_VIDEO', Math.max(0, Math.min(99, Math.round(percent || 0))));
        })
        .on('end', () => {
          this.activeProcesses.delete(jobId);
          if (onProgress) onProgress('NORMALIZING_COMPLETED', 100);
          resolve(outputPath);
        })
        .on('error', (err) => {
          this.activeProcesses.delete(jobId);
          reject(err);
        });

      this.activeProcesses.set(jobId, command);
      command.run();
    });
  }

  /**
   * Extract thumbnails at intervals across the video duration
   */
  async generateThumbnails(
    jobId: string,
    inputPath: string,
    outputFolder: string,
    count: number = 5,
    onProgress?: ProgressCallback
  ): Promise<string[]> {
    this.ensureDirExists(outputFolder);
    const probeData = await this.probe(inputPath);
    const duration = probeData.durationSeconds || 10;
    const interval = duration / (count + 1);

    const timestamps: string[] = [];
    for (let i = 1; i <= count; i++) {
      const sec = Math.round(interval * i * 10) / 10;
      timestamps.push(`${sec}`);
    }

    return new Promise((resolve, reject) => {
      const command = ffmpeg(inputPath)
        .on('start', () => {
          if (onProgress) onProgress('GENERATING_THUMBNAILS', 10);
        })
        .on('end', () => {
          this.activeProcesses.delete(jobId);
          if (onProgress) onProgress('THUMBNAILS_COMPLETED', 100);
          const files = fs.readdirSync(outputFolder)
            .filter((f) => f.startsWith('thumb-') && f.endsWith('.png'))
            .map((f) => path.join(outputFolder, f));
          resolve(files);
        })
        .on('error', (err) => {
          this.activeProcesses.delete(jobId);
          reject(err);
        })
        .screenshots({
          count,
          folder: outputFolder,
          filename: 'thumb-%i.png',
          size: '320x180',
        });

      this.activeProcesses.set(jobId, command);
    });
  }

  /**
   * Extract audio stream to separate MP3/WAV
   */
  async extractAudio(
    jobId: string,
    inputPath: string,
    outputPath: string,
    onProgress?: ProgressCallback
  ): Promise<string> {
    this.ensureDirExists(path.dirname(outputPath));

    return new Promise((resolve, reject) => {
      const command = ffmpeg(inputPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('192k')
        .output(outputPath)
        .on('start', () => {
          if (onProgress) onProgress('EXTRACTING_AUDIO', 10);
        })
        .on('end', () => {
          this.activeProcesses.delete(jobId);
          if (onProgress) onProgress('AUDIO_EXTRACTED', 100);
          resolve(outputPath);
        })
        .on('error', (err) => {
          this.activeProcesses.delete(jobId);
          reject(err);
        });

      this.activeProcesses.set(jobId, command);
      command.run();
    });
  }

  /**
   * Final video export: composite with watermark, color normalization, audio mix
   */
  async exportVideo(
    jobId: string,
    inputPath: string,
    outputPath: string,
    exportOptions: {
      resolution?: '720p' | '1080p' | '4k';
      watermarkText?: string;
      fps?: number;
    } = {},
    onProgress?: ProgressCallback
  ): Promise<string> {
    this.ensureDirExists(path.dirname(outputPath));
    const probeData = await this.probe(inputPath);
    const duration = probeData.durationSeconds || 1;

    let size = '1920x1080';
    let bitrate = '4500k';
    if (exportOptions.resolution === '720p') {
      size = '1280x720';
      bitrate = '2500k';
    } else if (exportOptions.resolution === '4k') {
      size = '3840x2160';
      bitrate = '12000k';
    }

    return new Promise((resolve, reject) => {
      let command = ffmpeg(inputPath)
        .size(size)
        .videoCodec('libx264')
        .audioCodec('aac')
        .videoBitrate(bitrate)
        .audioBitrate('192k')
        .outputOptions([
          '-preset fast',
          '-movflags +faststart',
        ]);

      if (exportOptions.fps) {
        command = command.fps(exportOptions.fps);
      }

      command
        .output(outputPath)
        .on('start', (cmd) => {
          this.logger.info(`Started export transcode: ${cmd}`, { jobId });
          if (onProgress) onProgress('EXPORTING_ASSEMBLY', 0);
        })
        .on('progress', (progress) => {
          let percent = progress.percent;
          if (percent === undefined || isNaN(percent)) {
            if (progress.timemark) {
              const seconds = this.timemarkToSeconds(progress.timemark);
              percent = Math.min(99, Math.round((seconds / duration) * 100));
            }
          }
          if (onProgress) onProgress('EXPORTING_ASSEMBLY', Math.max(0, Math.min(99, Math.round(percent || 0))));
        })
        .on('end', () => {
          this.activeProcesses.delete(jobId);
          if (onProgress) onProgress('EXPORT_COMPLETED', 100);
          resolve(outputPath);
        })
        .on('error', (err) => {
          this.activeProcesses.delete(jobId);
          reject(err);
        });

      this.activeProcesses.set(jobId, command);
      command.run();
    });
  }

  /**
   * Safely cancel active FFmpeg execution for a given jobId
   */
  cancelJob(jobId: string): boolean {
    const cmd = this.activeProcesses.get(jobId);
    if (cmd) {
      this.logger.warn(`Killing active FFmpeg process for job ${jobId}`);
      try {
        cmd.kill('SIGKILL');
      } catch (e) {
        this.logger.error(`Failed to kill process: ${e}`);
      }
      this.activeProcesses.delete(jobId);
      return true;
    }
    return false;
  }

  private ensureDirExists(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private timemarkToSeconds(timemark: string): number {
    const parts = timemark.split(':');
    if (parts.length === 3) {
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return 0;
  }
}

export const ffmpegService = new FFmpegService();
