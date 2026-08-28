import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';

export const Hello: React.FC<{title: string}> = ({title}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const opacity = interpolate(frame, [0, 20], [0, 1], {extrapolateRight: 'clamp'});
  const progress = frame / (durationInFrames - 1);

  return (
    <AbsoluteFill style={{backgroundColor: '#0b1220', justifyContent: 'center', alignItems: 'center'}}>
      <div style={{opacity, color: '#e8eefc', fontSize: 84, fontWeight: 700, letterSpacing: 2}}>{title}</div>
      <div style={{opacity, color: '#7fa2ff', fontSize: 36, marginTop: 24}}>
        Remotion 渲染链路自检 · {Math.round(progress * 100)}%
      </div>
    </AbsoluteFill>
  );
};
