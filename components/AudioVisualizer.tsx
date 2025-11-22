import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  isActive: boolean;
  analyser: AnalyserNode | null;
}

const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ isActive, analyser }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    if (!isActive || !analyser || !canvasRef.current) {
      if (canvasRef.current) {
         const ctx = canvasRef.current.getContext('2d');
         ctx?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      if (!isActive) return;
      
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw a mirrored bar visualizer
      const barWidth = (canvas.width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 2; 
        
        // Create a gradient
        const gradient = ctx.createLinearGradient(0, cy - barHeight, 0, cy + barHeight);
        gradient.addColorStop(0, '#3b82f6'); // Blue-500
        gradient.addColorStop(0.5, '#8b5cf6'); // Violet-500
        gradient.addColorStop(1, '#3b82f6');

        ctx.fillStyle = gradient;

        // Draw mirrored bars from center
        // Right side
        ctx.fillRect(cx + x, cy - barHeight / 2, barWidth, barHeight);
        // Left side
        ctx.fillRect(cx - x - barWidth, cy - barHeight / 2, barWidth, barHeight);

        x += barWidth + 1;
        
        if (x > cx) break; // Stop if we fill the width
      }
    };

    draw();

    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [isActive, analyser]);

  return (
    <canvas 
      ref={canvasRef} 
      width={600} 
      height={100} 
      className="w-full h-24 pointer-events-none opacity-80"
    />
  );
};

export default AudioVisualizer;