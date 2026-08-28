import {Composition} from 'remotion';
import {Hello} from './Hello';
import {Report, reportMetadata} from './report/Report';
import {demoProps} from './report/demoProps';

// `Hello` 是 OWLL-45 留下的渲染链路自检示例；`Report` 是报告模板本体，
// 帧数由 props 里的分镜时长决定（calculateMetadata），所以这里写的 durationInFrames 只是占位。
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Hello"
        component={Hello}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{title: '公司调研报告视频化 MVP'}}
      />
      <Composition
        id="Report"
        component={Report}
        durationInFrames={demoProps.totals.durationInFrames}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={demoProps}
        calculateMetadata={reportMetadata}
      />
    </>
  );
};
