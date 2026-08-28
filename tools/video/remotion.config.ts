import {Config} from '@remotion/cli/config';

// MVP 阶段固定 H.264 + 1080p30，与后续模板 stage 保持同一编码口径。
Config.setVideoImageFormat('jpeg');
Config.setCodec('h264');
Config.setOverwriteOutput(true);
