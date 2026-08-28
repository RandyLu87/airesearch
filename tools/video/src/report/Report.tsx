import {useEffect, useState} from 'react';
import {Audio, Sequence, continueRender, delayRender, staticFile, useVideoConfig} from 'remotion';
import {SceneBody, SceneFrame} from './Scenes';
import {INTER_FAMILY, INTER_FONT_FILE} from './theme';
import type {ReportProps} from './types';

/**
 * 加载站点那份自托管 Inter（拉丁与数字用它，中文仍走 PingFang SC，与研究站点逐字同源）。
 *
 * 必须挂 `delayRender`：Remotion 是逐帧截图，字体没加载完就开渲会让开头几帧用回退字形，
 * 成片里表现为「前两秒字突然变了一下」——这种错只能靠人眼发现。
 * 取不到字体时同样 `continueRender` 放行：字形回退是瑕疵，整条链路卡死不是。
 */
const useReportFont = () => {
  const [handle] = useState(() => delayRender('加载 Inter 字体'));
  useEffect(() => {
    const face = new FontFace(INTER_FAMILY, `url(${staticFile(INTER_FONT_FILE)}) format("woff2-variations")`, {
      weight: '100 900',
    });
    face
      .load()
      .then((loaded) => document.fonts.add(loaded))
      .catch(() => undefined)
      .finally(() => continueRender(handle));
  }, [handle]);
};

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
  useReportFont();

  return (
    <>
      {audioTrack ? <Audio src={staticFile(audioTrack)} /> : null}
      {scenes.map((scene, index) => (
        <Sequence key={`${scene.id}-${index}`} from={scene.from} durationInFrames={scene.durationInFrames} name={scene.id}>
          <SceneFrame
            progress={Math.min(1, (scene.from + scene.durationInFrames) / durationInFrames)}
            centered={scene.kind === 'closing'}
            captions={scene.captions ?? []}
          >
            <SceneBody scene={scene} dimensions={dimensions} companyName={companyName} dataCutoff={dataCutoff} />
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
