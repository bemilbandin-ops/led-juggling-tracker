import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { TrackerSettings, EffectSettings, TrackedObject, Particle } from '../types';
import { rgbToHsv, hsvToRgb, rgbToHex } from '../utils/color';

interface TrackingCanvasProps {
  trackerSettings: TrackerSettings;
  effectSettings: EffectSettings;
  selectedCameraId: string | null;
  onStatsChange: (stats: {
    activeClubs: number;
    fps: number;
    avgSpeed: number;
    tempo: number; // throws per minute
    peakSpeed: number;
  }) => void;
  onCameraListLoaded: (cameras: MediaDeviceInfo[]) => void;
  onSampleColor: (color: { r: number; g: number; b: number; h: number; s: number; v: number }) => void;
}

export interface TrackingCanvasRef {
  resetStats: () => void;
}

export const TrackingCanvas = forwardRef<TrackingCanvasRef, TrackingCanvasProps>(({
  trackerSettings,
  effectSettings,
  selectedCameraId,
  onStatsChange,
  onCameraListLoaded,
  onSampleColor
}, ref) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [isCameraActive, setIsCameraActive] = useState<boolean>(false);
  const [retryCount, setRetryCount] = useState<number>(0);

  // Core tracking states
  const trackedObjectsRef = useRef<TrackedObject[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const nextTrackIdRef = useRef<number>(1);
  const peakSpeedSessionRef = useRef<number>(0);

  // Multi-frame statistics & timing
  const lastFrameTimeRef = useRef<number>(performance.now());
  const fpsIntervalRef = useRef<number>(0);
  const frameCountRef = useRef<number>(0);
  const currentFpsRef = useRef<number>(0);
  const animationFrameIdRef = useRef<number | null>(null);

  // Peak detection for juggling tempo (Throws Per Minute)
  const throwPeaksRef = useRef<Array<{ id: string; time: number }>>([]);
  const previousYRef = useRef<Record<string, number>>({});
  const previousVyRef = useRef<Record<string, number>>({});

  // Reset session statistics
  const resetStats = () => {
    peakSpeedSessionRef.current = 0;
    throwPeaksRef.current = [];
    trackedObjectsRef.current = [];
    particlesRef.current = [];
  };

  useImperativeHandle(ref, () => ({
    resetStats
  }));

  // Enumerate cameras
  useEffect(() => {
    async function getCameras() {
      if (!navigator.mediaDevices) {
        console.error("Camera access requires secure context");
        return;
      }
      try {
        // Request permissions first to get complete labels
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach(track => track.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        onCameraListLoaded(videoDevices);
      } catch (err: any) {
        console.error("Failed to list cameras:", err);
      }
    }
    getCameras();
  }, [onCameraListLoaded, retryCount]);

  // Start Camera Stream
  useEffect(() => {
    let activeStream: MediaStream | null = null;

    async function startStream() {
      setError(null);
      setIsCameraActive(false);

      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }

      if (!navigator.mediaDevices) {
        setError("Camera access requires a secure context (HTTPS) or localhost. Please check your URL.");
        return;
      }

      const constraints: MediaStreamConstraints = {
        video: {
          deviceId: selectedCameraId ? { exact: selectedCameraId } : undefined,
          // Request high frame rate configuration if available for butter-smooth tracking
          frameRate: { ideal: 60, min: 30 },
          width: { ideal: 640 },
          height: { ideal: 480 }
        }
      };

      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        activeStream = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
          setIsCameraActive(true);
        }
      } catch (err: any) {
        console.error("Camera access failed:", err);
        setError(`Camera error: ${err.message || "Could not access device. Please check permissions."}`);
      }
    }

    startStream();

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [selectedCameraId, retryCount]);

  // Handle video resize and starts processing
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
      animationFrameIdRef.current = requestAnimationFrame(processingLoop);
    };

    video.addEventListener('playing', handlePlay);
    return () => {
      video.removeEventListener('playing', handlePlay);
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
    };
  }, [trackerSettings, effectSettings]);

  // Pixel picker / Color Sampler on click
  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = displayCanvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height;

    // To sample accurate color, we sample from a temporary tiny canvas that mirrors the video frame
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = video.videoWidth || 640;
    tempCanvas.height = video.videoHeight || 480;
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return;

    // Draw frame to extract color
    tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
    
    // Scale user clicked canvas coords to original video size
    const videoX = Math.round((x / canvas.width) * tempCanvas.width);
    const videoY = Math.round((y / canvas.height) * tempCanvas.height);

    try {
      const pixel = tempCtx.getImageData(videoX, videoY, 1, 1).data;
      const r = pixel[0];
      const g = pixel[1];
      const b = pixel[2];
      const hsv = rgbToHsv(r, g, b);

      onSampleColor({ r, g, b, ...hsv });
    } catch (e) {
      console.error("Sampling color error:", e);
    }
  };

  // Main Tracking & Rendering Loop
  const processingLoop = () => {
    const video = videoRef.current;
    const canvas = displayCanvasRef.current;
    const offscreen = offscreenCanvasRef.current;

    if (!video || !canvas || !offscreen || video.paused || video.ended) {
      animationFrameIdRef.current = requestAnimationFrame(processingLoop);
      return;
    }

    const ctx = canvas.getContext('2d');
    const oCtx = offscreen.getContext('2d', { willReadFrequently: true });

    if (!ctx || !oCtx) {
      animationFrameIdRef.current = requestAnimationFrame(processingLoop);
      return;
    }

    // Measure actual processing FPS
    const now = performance.now();
    const elapsed = now - lastFrameTimeRef.current;
    lastFrameTimeRef.current = now;
    
    frameCountRef.current++;
    fpsIntervalRef.current += elapsed;
    if (fpsIntervalRef.current >= 1000) {
      currentFpsRef.current = Math.round((frameCountRef.current * 1000) / fpsIntervalRef.current);
      frameCountRef.current = 0;
      fpsIntervalRef.current = 0;
    }

    // Synchronize canvas size with video size to preserve aspect ratio
    const videoWidth = video.videoWidth || 640;
    const videoHeight = video.videoHeight || 480;
    
    if (canvas.width !== videoWidth || canvas.height !== videoHeight) {
      canvas.width = videoWidth;
      canvas.height = videoHeight;
    }

    // Setup offscreen canvas for computer vision downscaling
    const processWidth = Math.max(16, Math.floor(videoWidth / trackerSettings.downscaleFactor));
    const processHeight = Math.max(12, Math.floor(videoHeight / trackerSettings.downscaleFactor));

    if (offscreen.width !== processWidth || offscreen.height !== processHeight) {
      offscreen.width = processWidth;
      offscreen.height = processHeight;
    }

    // 1. Draw video onto offscreen canvas for CV analysis
    oCtx.drawImage(video, 0, 0, processWidth, processHeight);
    const imgData = oCtx.getImageData(0, 0, processWidth, processHeight);
    const pixels = imgData.data;

    // 2. Perform pixel classification to identify potential LED components
    const candidates: Array<{ x: number; y: number; r: number; g: number; b: number }> = [];

    const mode = trackerSettings.mode;
    const targetH = trackerSettings.targetColor.h;
    const targetS = trackerSettings.targetColor.s;
    const targetV = trackerSettings.targetColor.v;
    const colorTolerance = trackerSettings.colorTolerance;
    const minBrightness = trackerSettings.minBrightness;
    const minSaturation = trackerSettings.minSaturation;

    for (let y = 0; y < processHeight; y++) {
      for (let x = 0; x < processWidth; x++) {
        const i = (y * processWidth + x) * 4;
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];

        // Core HSV classification
        const luma = 0.299 * r + 0.587 * g + 0.114 * b; // perceived brightness
        
        if (mode === 'brightness') {
          // In brightness mode, find anything highly bright
          if (luma >= minBrightness) {
            candidates.push({ x, y, r, g, b });
          }
        } else {
          // Color tracking mode: Convert current pixel to HSV
          const hsv = rgbToHsv(r, g, b);
          
          if (hsv.v >= minBrightness && hsv.s >= minSaturation) {
            // Compute circular difference in hue channel
            let dh = Math.abs(hsv.h - targetH);
            if (dh > 180) dh = 360 - dh;

            // Normalize differences
            const hueDiff = dh / 1.8; // map 0-180 diff to 0-100 scale
            const satDiff = Math.abs(hsv.s - targetS);
            const valDiff = Math.abs(hsv.v - targetV);

            // Distance calculation prioritizing Hue
            const distance = Math.sqrt(hueDiff * hueDiff * 0.75 + satDiff * satDiff * 0.15 + valDiff * valDiff * 0.10);

            if (distance <= colorTolerance) {
              candidates.push({ x, y, r, g, b });
            }
          }
        }
      }
    }

    // 3. Grid-based spatial clustering to group candidates into distinct physical objects (blobs)
    // Using a 12x12 grid cell size for fast, non-recursive grouping
    const cellSize = 8; 
    const gridCols = Math.ceil(processWidth / cellSize);
    const gridRows = Math.ceil(processHeight / cellSize);
    
    // Initialize empty grid tracking cell candidates
    const cellCounts = new Int32Array(gridCols * gridRows);
    const cellColorsR = new Float32Array(gridCols * gridRows);
    const cellColorsG = new Float32Array(gridCols * gridRows);
    const cellColorsB = new Float32Array(gridCols * gridRows);

    for (const c of candidates) {
      const cx = Math.floor(c.x / cellSize);
      const cy = Math.floor(c.y / cellSize);
      if (cx >= 0 && cx < gridCols && cy >= 0 && cy < gridRows) {
        const idx = cy * gridCols + cx;
        cellCounts[idx]++;
        cellColorsR[idx] += c.r;
        cellColorsG[idx] += c.g;
        cellColorsB[idx] += c.b;
      }
    }

    // Active cells must contain at least 15% density of candidate pixels
    const minPixelsPerCell = Math.max(1, Math.floor((cellSize * cellSize) * 0.12));
    const activeCells: number[] = [];
    for (let i = 0; i < cellCounts.length; i++) {
      if (cellCounts[i] >= minPixelsPerCell) {
        activeCells.push(i);
      }
    }

    // Union-Find / Connected Component analysis on active cells
    const parent = new Int32Array(gridCols * gridRows);
    for (let i = 0; i < parent.length; i++) parent[i] = i;

    const find = (i: number): number => {
      let root = i;
      while (parent[root] !== root) {
        root = parent[root];
      }
      // Path compression
      let curr = i;
      while (curr !== root) {
        const nxt = parent[curr];
        parent[curr] = root;
        curr = nxt;
      }
      return root;
    };

    const union = (i: number, j: number) => {
      const rootI = find(i);
      const rootJ = find(j);
      if (rootI !== rootJ) {
        parent[rootI] = rootJ;
      }
    };

    // Link adjacent cells (8-way connectivity)
    for (const idx of activeCells) {
      const cx = idx % gridCols;
      const cy = Math.floor(idx / gridCols);

      const neighbors = [
        { x: cx + 1, y: cy },
        { x: cx,     y: cy + 1 },
        { x: cx + 1, y: cy + 1 },
        { x: cx - 1, y: cy + 1 }
      ];

      for (const n of neighbors) {
        if (n.x >= 0 && n.x < gridCols && n.y >= 0 && n.y < gridRows) {
          const nIdx = n.y * gridCols + n.x;
          if (cellCounts[nIdx] >= minPixelsPerCell) {
            union(idx, nIdx);
          }
        }
      }
    }

    // Group active cells by their roots to assemble actual objects
    const groups: Record<number, number[]> = {};
    for (const idx of activeCells) {
      const root = find(idx);
      if (!groups[root]) groups[root] = [];
      groups[root].push(idx);
    }

    // Construct raw blob coordinate targets
    interface Blob {
      x: number; // normalized coordinate (0-100)
      y: number; // normalized coordinate (0-100)
      canvasX: number; // actual display coordinates
      canvasY: number;
      size: number;
      color: { r: number; g: number; b: number };
    }

    const detectedBlobs: Blob[] = [];
    const minBlobSize = 4; // minimum cells in a cluster to be considered a club

    for (const rootStr in groups) {
      const indices = groups[rootStr];
      if (indices.length < minBlobSize) continue;

      let sumX = 0;
      let sumY = 0;
      let totalCandPixels = 0;
      let rAcc = 0, gAcc = 0, bAcc = 0;

      for (const idx of indices) {
        const cx = idx % gridCols;
        const cy = Math.floor(idx / gridCols);
        const cellPixelCount = cellCounts[idx];

        // Compute centroid weighted by pixel count inside cell
        sumX += (cx * cellSize + cellSize / 2) * cellPixelCount;
        sumY += (cy * cellSize + cellSize / 2) * cellPixelCount;
        totalCandPixels += cellPixelCount;

        rAcc += cellColorsR[idx];
        gAcc += cellColorsG[idx];
        bAcc += cellColorsB[idx];
      }

      if (totalCandPixels > 0) {
        const rawX = sumX / totalCandPixels;
        const rawY = sumY / totalCandPixels;

        // Convert offscreen processed pixels back to display canvas dimensions
        const scaleX = videoWidth / processWidth;
        const scaleY = videoHeight / processHeight;
        
        const canvasX = rawX * scaleX;
        const canvasY = rawY * scaleY;

        detectedBlobs.push({
          x: (canvasX / videoWidth) * 100,
          y: (canvasY / videoHeight) * 100,
          canvasX,
          canvasY,
          size: totalCandPixels,
          color: {
            r: Math.round(rAcc / totalCandPixels),
            g: Math.round(gAcc / totalCandPixels),
            b: Math.round(bAcc / totalCandPixels)
          }
        });
      }
    }

    // 4. Update track states (Frame-to-Frame Temporal Tracking)
    const activeTracks = trackedObjectsRef.current;
    
    // Decrement life and decay velocities for existing tracks
    for (const track of activeTracks) {
      track.life--;
      // Dampen velocity when coasting
      track.vx *= 0.85;
      track.vy *= 0.85;
      track.pulseTimer = (track.pulseTimer + 1) % 1000;
    }

    // Greedy nearest-neighbor association
    const maxMatchDistance = Math.max(80, videoWidth * 0.15); // Dynamic matching threshold
    const matchedBlobs = new Set<number>();

    for (const track of activeTracks) {
      let bestBlobIdx = -1;
      let minDistance = Infinity;

      for (let j = 0; j < detectedBlobs.length; j++) {
        if (matchedBlobs.has(j)) continue;

        const blob = detectedBlobs[j];
        // Calculate Euclidean distance between previous position and blob
        const dx = blob.canvasX - track.canvasX;
        const dy = blob.canvasY - track.canvasY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < minDistance && dist < maxMatchDistance) {
          minDistance = dist;
          bestBlobIdx = j;
        }
      }

      if (bestBlobIdx !== -1) {
        matchedBlobs.add(bestBlobIdx);
        const blob = detectedBlobs[bestBlobIdx];

        // Smooth coordinate updates using Exponential Moving Average to prevent noise jitter
        const smoothingFactor = 0.45; // 0 is stiff tracking, 1 is teleport
        const prevCanvasX = track.canvasX;
        const prevCanvasY = track.canvasY;

        track.canvasX = prevCanvasX * (1 - smoothingFactor) + blob.canvasX * smoothingFactor;
        track.canvasY = prevCanvasY * (1 - smoothingFactor) + blob.canvasY * smoothingFactor;
        
        track.x = (track.canvasX / videoWidth) * 100;
        track.y = (track.canvasY / videoHeight) * 100;

        // Velocity represents movement delta
        track.vx = track.canvasX - prevCanvasX;
        track.vy = track.canvasY - prevCanvasY;

        // Reset track state
        track.life = track.maxLife; // refresh life
        track.color = blob.color;

        // Track history path
        track.history.push({
          x: track.x,
          y: track.y,
          canvasX: track.canvasX,
          canvasY: track.canvasY,
          t: now
        });

        if (track.history.length > effectSettings.trailLength) {
          track.history.shift();
        }

        // Active motion detection
        const speed = Math.sqrt(track.vx * track.vx + track.vy * track.vy);
        if (speed >= trackerSettings.motionSensitivity) {
          track.isMoving = true;
          track.stationaryCount = 0;
        } else {
          track.stationaryCount++;
          if (track.stationaryCount > 10) { // ~0.16s stationary limit
            track.isMoving = false;
          }
        }

        // Record peak velocities for stats
        if (speed > peakSpeedSessionRef.current) {
          peakSpeedSessionRef.current = speed;
        }

        // Juggling peak detection (estimating tempo)
        // A peak occurs when the club reaches the apex of a throw: vertical velocity vy shifts from upwards (-) to downwards (+)
        const lastY = previousYRef.current[track.id] || 0;
        const lastVy = previousVyRef.current[track.id] || 0;

        if (lastVy < -0.5 && track.vy > 0.5) {
          // Club reached peak height! Record throw timestamp
          throwPeaksRef.current.push({ id: track.id, time: now });
        }

        previousYRef.current[track.id] = track.canvasY;
        previousVyRef.current[track.id] = track.vy;
      }
    }

    // Spawn new tracks for remaining unmatched blobs
    for (let j = 0; j < detectedBlobs.length; j++) {
      if (matchedBlobs.has(j)) continue;

      const blob = detectedBlobs[j];
      const newId = `club_${nextTrackIdRef.current++}`;
      
      activeTracks.push({
        id: newId,
        x: blob.x,
        y: blob.y,
        canvasX: blob.canvasX,
        canvasY: blob.canvasY,
        vx: 0,
        vy: 0,
        color: blob.color,
        history: [{ x: blob.x, y: blob.y, canvasX: blob.canvasX, canvasY: blob.canvasY, t: now }],
        life: 8, // frame dropout allowance
        maxLife: 8,
        stationaryCount: 0,
        isMoving: false,
        pulseTimer: Math.floor(Math.random() * 100)
      });
    }

    // Filter out decayed tracks
    const survivingTracks = activeTracks.filter(track => track.life > 0);
    trackedObjectsRef.current = survivingTracks;

    // 5. Clean up old peaks & calculate real-time Juggling Tempo (Throws Per Minute)
    // Keep only peaks from the last 6 seconds
    const sixSecondsAgo = now - 6000;
    throwPeaksRef.current = throwPeaksRef.current.filter(p => p.time > sixSecondsAgo);
    
    // Estimate throwing tempo: (count of peaks / 6 seconds) * 60 seconds = count * 10
    // If we have active moving clubs, estimate tempo
    const activeMovingClubs = survivingTracks.filter(t => !trackerSettings.motionFilter || t.isMoving);
    const calculatedTempo = activeMovingClubs.length > 0 && throwPeaksRef.current.length > 1
      ? Math.round(throwPeaksRef.current.length * 10) 
      : 0;

    // Average speed of active clubs
    let totalSpeed = 0;
    let speedCount = 0;
    survivingTracks.forEach(t => {
      if (!trackerSettings.motionFilter || t.isMoving) {
        totalSpeed += Math.sqrt(t.vx * t.vx + t.vy * t.vy);
        speedCount++;
      }
    });
    const avgSpeed = speedCount > 0 ? totalSpeed / speedCount : 0;

    // Callback with unified live statistics
    onStatsChange({
      activeClubs: activeMovingClubs.length,
      fps: currentFpsRef.current,
      avgSpeed: parseFloat(avgSpeed.toFixed(1)),
      tempo: calculatedTempo,
      peakSpeed: parseFloat(peakSpeedSessionRef.current.toFixed(1))
    });

    // 6. Draw background and effects onto display canvas
    ctx.clearRect(0, 0, videoWidth, videoHeight);
    
    // Always render pristine, unmodified background video footage
    ctx.drawImage(video, 0, 0, videoWidth, videoHeight);

    // Filter particles and update them
    let particles = particlesRef.current;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life--;
      p.alpha = p.life / p.maxLife;
      if (p.life <= 0) {
        particles.splice(i, 1);
      }
    }

    // Render individual particles
    for (const p of particles) {
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      
      if (effectSettings.particleType === 'sparkles') {
        // Draw elegant diamond star
        const r = p.size;
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r / 2, p.y - r / 2);
        ctx.lineTo(p.x + r, p.y);
        ctx.lineTo(p.x + r / 2, p.y + r / 2);
        ctx.lineTo(p.x, p.y + r);
        ctx.lineTo(p.x - r / 2, p.y + r / 2);
        ctx.lineTo(p.x - r, p.y);
        ctx.lineTo(p.x - r / 2, p.y - r / 2);
      } else {
        // Simple glowing circle
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      }
      
      ctx.fill();
      ctx.restore();
    }

    // Spawn new particles for active moving objects
    for (const track of survivingTracks) {
      if (trackerSettings.motionFilter && !track.isMoving) continue;
      if (effectSettings.particleType === 'none') continue;

      const pColor = getEffectColor(track, effectSettings);
      
      // Velocity-directed particles (trail particles)
      const speed = Math.sqrt(track.vx * track.vx + track.vy * track.vy);
      const angle = speed > 0.1 ? Math.atan2(track.vy, track.vx) : Math.random() * Math.PI * 2;

      for (let k = 0; k < effectSettings.particleDensity; k++) {
        // Slightly random scattering in the opposite direction of motion
        const scatterAngle = angle + Math.PI + (Math.random() - 0.5) * 1.5;
        const scatterSpeed = (Math.random() * 0.4 + 0.1) * Math.max(2, speed);
        
        const size = effectSettings.particleType === 'sparkles'
          ? Math.random() * 4 + 2
          : effectSettings.particleType === 'smoke'
            ? Math.random() * 8 + 4
            : Math.random() * 6 + 3; // magic dust

        const maxLife = effectSettings.particleType === 'smoke' ? 45 : 30;

        particles.push({
          x: track.canvasX + (Math.random() - 0.5) * 10,
          y: track.canvasY + (Math.random() - 0.5) * 10,
          vx: Math.cos(scatterAngle) * scatterSpeed + (Math.random() - 0.5) * 1.5,
          vy: Math.sin(scatterAngle) * scatterSpeed + (Math.random() - 0.5) * 1.5,
          size,
          color: pColor,
          alpha: 1,
          life: maxLife,
          maxLife
        });
      }
    }

    // Render Trails
    if (effectSettings.trailType !== 'none') {
      for (const track of survivingTracks) {
        if (trackerSettings.motionFilter && !track.isMoving) continue;
        if (track.history.length < 2) continue;

        const colorHex = getEffectColor(track, effectSettings);

        if (effectSettings.trailType === 'neon') {
          // Draw bright glowing core with wider, softer halo underneath
          ctx.save();
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          // Pass 1: Outer wide glow
          ctx.shadowColor = colorHex;
          ctx.shadowBlur = 15;
          ctx.strokeStyle = colorHex;
          ctx.lineWidth = effectSettings.trailWidth * 2;
          ctx.beginPath();
          ctx.moveTo(track.history[0].canvasX, track.history[0].canvasY);
          for (let i = 1; i < track.history.length; i++) {
            ctx.lineTo(track.history[i].canvasX, track.history[i].canvasY);
          }
          ctx.stroke();

          // Pass 2: High intensity core (white center)
          ctx.shadowBlur = 0;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = Math.max(2, effectSettings.trailWidth * 0.4);
          ctx.stroke();
          ctx.restore();

        } else if (effectSettings.trailType === 'ribbon') {
          // Beautiful tapering ribbon polygons with transparency
          ctx.save();
          const len = track.history.length;

          for (let i = 0; i < len - 1; i++) {
            const p1 = track.history[i];
            const p2 = track.history[i + 1];
            const ratio = i / len;
            const width = effectSettings.trailWidth * ratio;

            // Compute perpendicular vector for ribbon width
            const dx = p2.canvasX - p1.canvasX;
            const dy = p2.canvasY - p1.canvasY;
            const length = Math.sqrt(dx * dx + dy * dy);

            if (length > 0.1) {
              const nx = -dy / length;
              const ny = dx / length;

              ctx.fillStyle = colorHex;
              ctx.globalAlpha = 0.35 * ratio;

              ctx.beginPath();
              ctx.moveTo(p1.canvasX - nx * width, p1.canvasY - ny * width);
              ctx.lineTo(p2.canvasX - nx * width, p2.canvasY - ny * width);
              ctx.lineTo(p2.canvasX + nx * width, p2.canvasY + ny * width);
              ctx.lineTo(p1.canvasX + nx * width, p1.canvasY + ny * width);
              ctx.closePath();
              ctx.fill();
            }
          }
          ctx.restore();

        } else if (effectSettings.trailType === 'rainbow') {
          // Segment-by-segment color shifting trail
          ctx.save();
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          
          for (let i = 0; i < track.history.length - 1; i++) {
            const p1 = track.history[i];
            const p2 = track.history[i + 1];
            const ratio = i / track.history.length;
            
            // Cycle through hues along path length
            const segmentHue = (track.pulseTimer * 1.5 + ratio * 360) % 360;
            const segmentColor = rgbToHex(
              hsvToRgb(segmentHue, 95, 95).r,
              hsvToRgb(segmentHue, 95, 95).g,
              hsvToRgb(segmentHue, 95, 95).b
            );

            ctx.strokeStyle = segmentColor;
            ctx.lineWidth = effectSettings.trailWidth * ratio;
            ctx.beginPath();
            ctx.moveTo(p1.canvasX, p1.canvasY);
            ctx.lineTo(p2.canvasX, p2.canvasY);
            ctx.stroke();
          }
          ctx.restore();
        }
      }
    }

    // Render Glow Pulse
    if (effectSettings.glowType !== 'none') {
      for (const track of survivingTracks) {
        if (trackerSettings.motionFilter && !track.isMoving) continue;

        const baseColor = getEffectColor(track, effectSettings);
        const { r, g, b } = rgbToRgbObj(baseColor);

        ctx.save();
        
        if (effectSettings.glowType === 'pulse') {
          // Breathing concentric radial gradient
          const pulseScale = 1 + 0.25 * Math.sin(track.pulseTimer * 0.15);
          const size = effectSettings.glowSize * pulseScale;

          const grad = ctx.createRadialGradient(track.canvasX, track.canvasY, 1, track.canvasX, track.canvasY, size);
          grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.85)`);
          grad.addColorStop(0.3, `rgba(${r}, ${g}, ${b}, 0.3)`);
          grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(track.canvasX, track.canvasY, size, 0, Math.PI * 2);
          ctx.fill();

        } else if (effectSettings.glowType === 'halo') {
          // Sharp neon ring outlining the LED point
          ctx.strokeStyle = baseColor;
          ctx.shadowColor = baseColor;
          ctx.shadowBlur = 10;
          ctx.lineWidth = 3;
          
          ctx.beginPath();
          ctx.arc(track.canvasX, track.canvasY, effectSettings.glowSize * 0.5, 0, Math.PI * 2);
          ctx.stroke();

        } else if (effectSettings.glowType === 'spark') {
          // Elegant sunburst lines radiating outward
          const size = effectSettings.glowSize;
          const rayCount = 8;
          const rotation = track.pulseTimer * 0.02;

          ctx.strokeStyle = baseColor;
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.75;

          for (let rIdx = 0; rIdx < rayCount; rIdx++) {
            const angle = (rIdx / rayCount) * Math.PI * 2 + rotation;
            const innerR = size * 0.2;
            const outerR = size * (0.8 + 0.25 * Math.sin(track.pulseTimer * 0.1 + rIdx));

            ctx.beginPath();
            ctx.moveTo(track.canvasX + Math.cos(angle) * innerR, track.canvasY + Math.sin(angle) * innerR);
            ctx.lineTo(track.canvasX + Math.cos(angle) * outerR, track.canvasY + Math.sin(angle) * outerR);
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }

    // Render Overlays
    if (effectSettings.overlayType !== 'none') {
      for (const track of survivingTracks) {
        if (trackerSettings.motionFilter && !track.isMoving) continue;

        const baseColor = getEffectColor(track, effectSettings);

        if (effectSettings.overlayType === 'cyber') {
          // Futuristic hud target ring
          ctx.save();
          ctx.strokeStyle = baseColor;
          ctx.fillStyle = baseColor;
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = 0.65;

          const size = 35;
          
          // Spinning bracket ticks
          const spinAngle = track.pulseTimer * 0.015;
          ctx.beginPath();
          ctx.arc(track.canvasX, track.canvasY, size, spinAngle, spinAngle + Math.PI * 0.4);
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(track.canvasX, track.canvasY, size, spinAngle + Math.PI, spinAngle + Math.PI * 1.4);
          ctx.stroke();

          // Speed telemetry tag (No tech slop, real math-driven speed values!)
          const speedPixelsPerSec = Math.round(Math.sqrt(track.vx * track.vx + track.vy * track.vy) * 60);
          ctx.font = '500 10px monospace';
          ctx.fillText(`ID:${track.id.split('_')[1]}`, track.canvasX + size + 6, track.canvasY - 4);
          ctx.fillText(`${speedPixelsPerSec} px/s`, track.canvasX + size + 6, track.canvasY + 8);
          
          // Tiny crosshair dot
          ctx.beginPath();
          ctx.arc(track.canvasX, track.canvasY, 2, 0, Math.PI * 2);
          ctx.fill();

          ctx.restore();

        } else if (effectSettings.overlayType === 'bubbles') {
          // Rising translucent soap bubbles
          if (track.isMoving && Math.random() < 0.12) {
            const bSize = Math.random() * 12 + 6;
            particles.push({
              x: track.canvasX + (Math.random() - 0.5) * 20,
              y: track.canvasY + (Math.random() - 0.5) * 20,
              vx: (Math.random() - 0.5) * 1,
              vy: -Math.random() * 1.5 - 0.5, // Float upwards
              size: bSize,
              color: `rgba(${rgbToRgbObj(baseColor).r}, ${rgbToRgbObj(baseColor).g}, ${rgbToRgbObj(baseColor).b}, 0.25)`,
              alpha: 1,
              life: 80,
              maxLife: 80
            });
          }
        }
      }
    }

    // Keep loop humming at refresh rate
    animationFrameIdRef.current = requestAnimationFrame(processingLoop);
  };

  // Helper function to extract correct drawing hex color
  const getEffectColor = (track: TrackedObject, settings: EffectSettings): string => {
    if (settings.effectColorMode === 'custom') {
      return settings.customColor;
    } else if (settings.effectColorMode === 'rainbow') {
      const hue = (track.pulseTimer * 2.5) % 360;
      const rgb = hsvToRgb(hue, 95, 95);
      return rgbToHex(rgb.r, rgb.g, rgb.b);
    } else {
      // Matches the actual detected LED light pixel color
      return rgbToHex(track.color.r, track.color.g, track.color.b);
    }
  };

  // Helper conversion for transparency gradients
  const rgbToRgbObj = (hex: string) => {
    const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
    const fullHex = hex.replace(shorthandRegex, (_, r, g, b) => r + r + g + g + b + b);
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(fullHex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 59, g: 130, b: 246 }; // Tailwind blue default
  };

  return (
    <div id="tracking_viewport_container" className="relative w-full aspect-video md:aspect-[4/3] lg:aspect-video rounded-none overflow-hidden bg-[#0C0C0E] border border-white/10 shadow-2xl group">
      {/* Underlying raw streaming video (hidden from display, used as tracker input buffer) */}
      <video
        id="camera_input_stream"
        ref={videoRef}
        className="hidden"
        playsInline
        muted
      />

      {/* Main interactive tracking display */}
      <canvas
        id="display_output_canvas"
        ref={displayCanvasRef}
        onClick={handleCanvasClick}
        className="w-full h-full object-cover cursor-crosshair block transition-opacity duration-300"
        style={{ opacity: isCameraActive ? 1 : 0.35 }}
      />

      {/* Offscreen computer-vision sandbox for ultra-fast processing (hidden) */}
      <canvas
        id="cv_analysis_sandbox"
        ref={offscreenCanvasRef}
        className="hidden"
      />

      {/* Frame assistance guidelines & hints overlay */}
      {isCameraActive && (
        <div id="canvas_calibration_watermark" className="absolute top-4 left-4 flex items-center space-x-2 bg-[#0C0C0E]/95 px-3 py-1.5 rounded-none border border-cyan-500/20 select-none pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300 shadow-md">
          <div className="w-2 h-2 rounded-none bg-cyan-400 animate-pulse" />
          <span className="text-[10px] font-mono font-bold text-cyan-400 uppercase tracking-widest">
            TAP CANVAS TO SAMPLE COLOR HUE
          </span>
        </div>
      )}

      {/* Loading & Error Overlays */}
      {!isCameraActive && !error && (
        <div id="loading_overlay" className="absolute inset-0 flex flex-col items-center justify-center bg-[#0C0C0E]/95 backdrop-blur-sm">
          <div className="w-12 h-12 rounded-none border-2 border-white/5 border-t-2 border-t-cyan-400 animate-spin mb-4" />
          <p className="text-xs font-mono font-bold tracking-widest text-neutral-300 uppercase">INITIALIZING INTEGRATION STREAM...</p>
          <p className="text-[10px] font-mono text-neutral-500 uppercase mt-1">Accept camera prompt permissions when requested</p>
        </div>
      )}

      {error && (
        <div id="error_overlay" className="absolute inset-0 flex flex-col items-center justify-center bg-[#0C0C0E] p-6 text-center">
          <div className="w-12 h-12 rounded-none bg-red-950/20 flex items-center justify-center border border-red-500/30 text-red-400 font-bold mb-4 text-sm font-mono">!</div>
          <p className="text-xs font-mono font-bold uppercase tracking-widest text-red-400 mb-1">Camera Stream Inaccessible</p>
          <p className="text-[11px] text-neutral-400 max-w-sm mb-4 font-mono uppercase tracking-wide">
            {error}
          </p>
          <button
            id="retry_camera_btn"
            onClick={() => {
              setRetryCount(prev => prev + 1);
            }}
            className="px-5 py-2.5 bg-red-500/10 hover:bg-red-500/20 active:bg-red-950/40 border border-red-500/30 hover:border-red-500/50 text-[10px] font-mono font-bold text-red-400 uppercase tracking-widest rounded-none transition-all cursor-pointer"
          >
            Retry Stream Link
          </button>
        </div>
      )}
    </div>
  );
});

TrackingCanvas.displayName = 'TrackingCanvas';
