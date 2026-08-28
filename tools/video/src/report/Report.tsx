import {Audio, Sequence, staticFile, useVideoConfig} from 'remotion';
import {SceneBody, SceneFrame} from './Scenes';
import type {ReportProps} from './types';

/**
 * 报告视频模板。画面结构完全由 props 决定，没有任何一家公司的字面量：
 * 换一份「分镜文案 JSON + 音频清单」就是另一家公司的片子。
 *
 * 音轨是 render.mjs 用 FFmpeg 按分镜顺序拼好的单条文件，每段已经补静音到
 * 与对应 Sequence 完全相同的长度，所以这里在第 0 帧挂一次就天然对齐，
 * 不需要逐段 <Audio> 也不会有累积漂移。预览（audioTrack === null）时静音渲染。
 */
export const Report: React.FC<ReportProps> = ({
  companyName,
  companyId,
  dataCutoff,
  dimensions,
  scenes,
  audioTrack,
  totals,
}) => {
  const {durationInFrames} = useVideoConfig();

  return (
    <>
      {audioTrack ? <Audio src={staticFile(audioTrack)} /> : null}
      {scenes.map((scene, index) => (
        <Sequence key={`${scene.id}-${index}`} from={scene.from} durationInFrames={scene.durationInFrames} name={scene.id}>
          <SceneFrame
            header={companyName}
            footer={`${index + 1} / ${totals.sceneCount}　·　数据截止 ${dataCutoff ?? '未标注'}`}
            progress={Math.min(1, (scene.from + scene.durationInFrames) / durationInFrames)}
            centered={scene.kind === 'closing'}
            captions={scene.captions ?? []}
          >
            <SceneBody
              scene={scene}
              dimensions={dimensions}
              companyName={companyName}
              companyId={companyId}
              dataCutoff={dataCutoff}
            />
          </SceneFrame>
        </Sequence>
      ))}
    </>
  );
};

/** 整片帧数就是各分镜帧数之和——画面跟着音频走，不反过来给音频派时长。 */
export const reportMetadata = ({props}: {props: ReportProps}) => ({
  durationInFrames: Math.max(1, props.totals?.durationInFrames ?? 1),
  fps: props.fps ?? 30,
});
