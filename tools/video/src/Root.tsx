import {Composition} from 'remotion';
import {Hello} from './Hello';

// 最小可运行示例：5 秒 1080p30。真正的报告模板在 stage 3 单独新增 composition，
// 这里只用来验证 Remotion + 打包的 FFmpeg 能在本机跑通渲染。
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Hello"
      component={Hello}
      durationInFrames={150}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{title: '公司调研报告视频化 MVP'}}
    />
  );
};
