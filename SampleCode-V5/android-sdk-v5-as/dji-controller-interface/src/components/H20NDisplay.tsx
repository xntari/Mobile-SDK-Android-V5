import React, { useRef, useEffect, useState } from 'react';
import { H20NDisplayProps } from '../types';

export const H20NDisplay: React.FC<H20NDisplayProps> = ({ 
  width, 
  height, 
  className = '',
  children
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoDecoderRef = useRef<VideoDecoder | null>(null);
  const offscreenCanvasRef = useRef<OffscreenCanvas | null>(null);
  const offscreenCtxRef = useRef<OffscreenCanvasRenderingContext2D | null>(null);
  const [videoStatus, setVideoStatus] = useState<'waiting' | 'loading' | 'playing' | 'error' | 'receiving' | 'decoding'>('waiting');
  const [frameStats, setFrameStats] = useState({ frames: 0, totalBytes: 0, lastFrame: 0, decodedFrames: 0 });
  const [decoderSupported, setDecoderSupported] = useState<boolean | null>(null);
  const [videoDimensions, setVideoDimensions] = useState({ width: 1920, height: 1080 });
  const [displayRect, setDisplayRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const spsRef = useRef<Uint8Array | null>(null);
  const ppsRef = useRef<Uint8Array | null>(null);
  const decoderConfiguredRef = useRef<boolean>(false);

  // Calculate actual video display rectangle with object-contain behavior
  const calculateDisplayRect = () => {
    if (!containerRef.current) return;
    
    const container = containerRef.current;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    
    const videoAspect = videoDimensions.width / videoDimensions.height;
    const containerAspect = containerWidth / containerHeight;
    
    let displayWidth, displayHeight, left, top;
    
    if (containerAspect > videoAspect) {
      // Container is wider than video - fit by height
      displayHeight = containerHeight;
      displayWidth = displayHeight * videoAspect;
      left = (containerWidth - displayWidth) / 2;
      top = 0;
    } else {
      // Container is taller than video - fit by width
      displayWidth = containerWidth;
      displayHeight = displayWidth / videoAspect;
      left = 0;
      top = (containerHeight - displayHeight) / 2;
    }
    
    setDisplayRect({ left, top, width: displayWidth, height: displayHeight });
  };

  // Update display rect when container size or video dimensions change
  useEffect(() => {
    calculateDisplayRect();
    
    const resizeObserver = new ResizeObserver(() => {
      calculateDisplayRect();
    });
    
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    
    return () => resizeObserver.disconnect();
  }, [videoDimensions]);

  // H.264 NAL unit parsing helpers
  const parseH264NALUnits = (data: Uint8Array) => {
    const nalUnits: { type: number; data: Uint8Array }[] = [];
    let offset = 0;

    while (offset < data.length - 4) {
      // Look for start code (0x00 0x00 0x00 0x01)
      if (data[offset] === 0x00 && data[offset + 1] === 0x00 && 
          data[offset + 2] === 0x00 && data[offset + 3] === 0x01) {
        
        // Found start code, find the next one
        let nextOffset = offset + 4;
        while (nextOffset < data.length - 3) {
          if (data[nextOffset] === 0x00 && data[nextOffset + 1] === 0x00 && 
              data[nextOffset + 2] === 0x00 && data[nextOffset + 3] === 0x01) {
            break;
          }
          nextOffset++;
        }
        
        if (nextOffset > offset + 4) {
          const nalData = data.slice(offset + 4, nextOffset);
          const nalType = nalData[0] & 0x1F;
          nalUnits.push({ type: nalType, data: nalData });
        }
        
        offset = nextOffset;
      } else {
        offset++;
      }
    }
    
    return nalUnits;
  };

  const isKeyFrame = (nalUnits: { type: number; data: Uint8Array }[]) => {
    // NAL unit types: 1=P, 5=IDR (keyframe), 7=SPS, 8=PPS
    return nalUnits.some(nal => nal.type === 5); // IDR frame
  };

  const extractConfigData = (nalUnits: { type: number; data: Uint8Array }[]) => {
    const sps = nalUnits.find(nal => nal.type === 7)?.data;
    const pps = nalUnits.find(nal => nal.type === 8)?.data;
    return { sps, pps };
  };

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    // Check if WebCodecs is supported
    const checkWebCodecsSupport = async () => {
      if (typeof VideoDecoder === 'undefined') {
        console.warn('WebCodecs not supported in this environment');
        setDecoderSupported(false);
        setVideoStatus('error');
        return false;
      }

      try {
        const support = await VideoDecoder.isConfigSupported({
          codec: 'avc1.42E01E', // H.264 Baseline Profile
        });
        
        if (support.supported) {
          console.log('✅ H.264 WebCodecs decoding supported for H20N');
          setDecoderSupported(true);
          return true;
        } else {
          console.warn('❌ H.264 WebCodecs decoding not supported for H20N');
          setDecoderSupported(false);
          setVideoStatus('error');
          return false;
        }
      } catch (error) {
        console.error('Error checking WebCodecs support for H20N:', error);
        setDecoderSupported(false);
        setVideoStatus('error');
        return false;
      }
    };

    // Set up WebCodecs H.264 decoder
    const setupVideoDecoder = async () => {
      if (!canvasRef.current) return;
      if (!(await checkWebCodecsSupport())) return;

      try {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        
        if (!ctx) {
          throw new Error('Failed to get canvas context');
        }

        // Create offscreen canvas for double buffering
        offscreenCanvasRef.current = new OffscreenCanvas(1920, 1080);
        offscreenCtxRef.current = offscreenCanvasRef.current.getContext('2d');
        
        if (!offscreenCtxRef.current) {
          throw new Error('Failed to get offscreen canvas context');
        }

        // Create the decoder (but don't configure until we have SPS/PPS)
        videoDecoderRef.current = new VideoDecoder({
          output: (frame: VideoFrame) => {
            try {
              // Update video dimensions if changed
              if (videoDimensions.width !== frame.codedWidth || videoDimensions.height !== frame.codedHeight) {
                setVideoDimensions({ width: frame.codedWidth, height: frame.codedHeight });
              }
              
              // Resize offscreen canvas if needed
              const offscreenCanvas = offscreenCanvasRef.current;
              const offscreenCtx = offscreenCtxRef.current;
              
              if (!offscreenCanvas || !offscreenCtx) {
                frame.close();
                return;
              }
              
              if (offscreenCanvas.width !== frame.codedWidth || offscreenCanvas.height !== frame.codedHeight) {
                offscreenCanvas.width = frame.codedWidth;
                offscreenCanvas.height = frame.codedHeight;
              }
              
              // Draw frame to offscreen canvas (back buffer)
              offscreenCtx.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
              offscreenCtx.drawImage(frame, 0, 0);
              
              // Now atomically copy the complete frame to the visible canvas (front buffer)
              if (canvas.width !== frame.codedWidth || canvas.height !== frame.codedHeight) {
                canvas.width = frame.codedWidth;
                canvas.height = frame.codedHeight;
              }
              
              // This is atomic - no flicker
              ctx.drawImage(offscreenCanvas, 0, 0);
              
              frame.close();
              
              // Update stats and immediately set to playing state
              setFrameStats(prev => {
                const newFrameCount = prev.decodedFrames + 1;
                // Change to playing state immediately on first decoded frame
                if (newFrameCount === 1) {
                  setVideoStatus('playing');
                }
                return {
                  ...prev,
                  decodedFrames: newFrameCount
                };
              });
              
            } catch (error) {
              console.error('Error drawing video frame in H20N:', error);
              frame.close();
            }
          },
          error: (error: Error) => {
            console.error('H20N VideoDecoder error:', error);
            console.error('H20N Decoder state:', videoDecoderRef.current?.state);
            console.error('H20N Error details:', {
              name: error.name,
              message: error.message,
              stack: error.stack
            });
            setVideoStatus('error');
            // Reset decoder state on error
            decoderConfiguredRef.current = false;
            
            // Reset SPS/PPS to force reconfiguration
            spsRef.current = null;
            ppsRef.current = null;
            
            // Trigger decoder recreation after a short delay
            setTimeout(() => setupVideoDecoder(), 500);
          }
        });

        setVideoStatus('loading');

        cleanup = () => {
          if (videoDecoderRef.current && videoDecoderRef.current.state !== 'closed') {
            videoDecoderRef.current.close();
          }
          // Clean up offscreen canvas references
          offscreenCanvasRef.current = null;
          offscreenCtxRef.current = null;
        };

      } catch (error) {
        console.error('Failed to set up H20N video decoder:', error);
        setVideoStatus('error');
      }
    };

    // Handle incoming video frames - uses onSecondaryVideoFrame for secondary camera
    const handleVideoFrame = (frameInfo: any) => {
      if (!frameInfo) return;
      
      // Handle new format: { metadata: {...}, data: Buffer }
      const frameData = frameInfo.data;
      const metadata = frameInfo.metadata;
      
      if (!frameData) {
        console.warn('H20NDisplay: Received video frame without data');
        return;
      }
      
      console.log('🎥 H20N: Received secondary camera frame:', metadata?.frameNumber || 'unknown');
      
      // Update frame statistics and status
      const now = Date.now();
      setFrameStats(prev => ({
        frames: prev.frames + 1,
        totalBytes: prev.totalBytes + frameData.length,
        lastFrame: now,
        decodedFrames: prev.decodedFrames
      }));
      
      // Only update to 'receiving' if we're not already playing
      if (videoStatus === 'waiting' || videoStatus === 'loading') {
        setVideoStatus('receiving');
      }

      // Check if decoder exists
      if (!videoDecoderRef.current) {
        return;
      }

      try {
        // Convert data to Uint8Array for WebCodecs
        let h264Data: Uint8Array;
        
        if (frameData instanceof Uint8Array) {
          h264Data = frameData;
        } else if (frameData.buffer) {
          // Node.js Buffer (Electron)
          h264Data = new Uint8Array(
            frameData.buffer,
            frameData.byteOffset,
            frameData.byteLength
          );
        } else {
          console.error('Unsupported video data format in H20N:', typeof frameData);
          return;
        }

        if (h264Data.length === 0) {
          console.warn('Empty video frame in H20N, skipping');
          return;
        }

        // Parse NAL units
        const nalUnits = parseH264NALUnits(h264Data);
        if (nalUnits.length === 0) {
          return;
        }

        // Extract config data (SPS/PPS) if present
        const { sps, pps } = extractConfigData(nalUnits);
        if (sps) {
          spsRef.current = sps;
        }
        if (pps) {
          ppsRef.current = pps;
        }

        // Configure decoder if we have SPS/PPS and haven't configured yet
        if (!decoderConfiguredRef.current && spsRef.current && ppsRef.current && videoDecoderRef.current) {
          // Check if decoder exists and is not closed
          if (videoDecoderRef.current.state === 'closed') {
            console.log('H20N Decoder is closed, skipping configuration until recreated');
            return;
          }
          
          const sps = spsRef.current;
          const pps = ppsRef.current;
          const configData = new Uint8Array(sps.length + pps.length);
          let offset = 0;
          configData.set(sps, offset);
          offset += sps.length;
          configData.set(pps, offset);

          try {
            // Extract actual codec string from SPS
            const profile = sps[1].toString(16).padStart(2, '0').toUpperCase();
            const constraints = sps[2].toString(16).padStart(2, '0').toUpperCase(); 
            const level = sps[3].toString(16).padStart(2, '0').toUpperCase();
            const codecString = `avc1.${profile}${constraints}${level}`;
            
            // Try configuration without description first (simpler approach)
            try {
              videoDecoderRef.current.configure({
                codec: codecString
              });
            } catch (simpleError) {
              // Fallback to configuration with description
              videoDecoderRef.current.configure({
                codec: codecString,
                description: configData
              });
            }
            
            decoderConfiguredRef.current = true;
          } catch (error) {
            console.error('❌ Failed to configure H20N decoder:', error);
            decoderConfiguredRef.current = false;
            setVideoStatus('error');
            return;
          }
        }

        // Skip if decoder not configured or closed
        if (!decoderConfiguredRef.current || !videoDecoderRef.current || videoDecoderRef.current.state !== 'configured') {
          if (videoDecoderRef.current && videoDecoderRef.current.state === 'closed') {
            console.log('H20N Decoder closed, triggering recreation');
            decoderConfiguredRef.current = false;
            // Trigger recreation on next frame
            setTimeout(() => setupVideoDecoder(), 100);
          }
          return;
        }

        // Determine if this is a keyframe
        const isKey = isKeyFrame(nalUnits);

        // Skip non-key frames if decoder just configured (wait for next I-frame)
        if (!isKey && videoStatus === 'decoding') {
          return;
        }

        // Create EncodedVideoChunk for WebCodecs
        try {
          const chunk = new EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: now * 1000, // Convert to microseconds
            data: h264Data
          });

          // Only set to 'decoding' if we're not already playing or have decoded frames
          setFrameStats(prev => {
            if (prev.decodedFrames === 0 && videoStatus !== 'playing') {
              setVideoStatus('decoding');
            }
            return prev;
          });
          
          videoDecoderRef.current.decode(chunk);
        } catch (decodeError) {
          console.error('H20N Decode error:', decodeError);
          console.error('H20N Decode error details:', {
            name: decodeError.name,
            message: decodeError.message,
            decoderState: videoDecoderRef.current?.state
          });
          
          // If this was a key frame and it failed, reset the decoder
          if (isKey) {
            console.log('H20N Key frame decode failed, resetting decoder...');
            decoderConfiguredRef.current = false;
            spsRef.current = null;
            ppsRef.current = null;
            
            // Close and recreate decoder
            if (videoDecoderRef.current) {
              try {
                // Close the decoder regardless of current state
                videoDecoderRef.current.close();
              } catch (closeError) {
                console.warn('Error closing H20N decoder:', closeError);
              }
            }
            
            // Trigger decoder recreation on next frame
            setTimeout(() => setupVideoDecoder(), 100);
          }
        }
        
      } catch (error) {
        console.error('Failed to decode H20N video frame:', error);
        setVideoStatus('error');
        // Reset decoder state on error
        decoderConfiguredRef.current = false;
      }
    };

    setupVideoDecoder();

    // Listen for secondary video frames from main process
    (window.electronAPI as any).onSecondaryVideoFrame(handleVideoFrame);

    return () => {
      cleanup?.();
      window.electronAPI.removeAllListeners('secondary-video-frame');
    };
  }, []);

  const getStatusOverlay = () => {
    switch (videoStatus) {
      case 'waiting':
        return (
          <div className="absolute inset-0 bg-dji-dark bg-opacity-80 flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-4">📹</div>
              <div className="text-lg text-gray-300">Waiting for H20N Stream</div>
              <div className="text-sm text-gray-500 mt-2">
                Secondary camera (gimbal/H20N)
              </div>
            </div>
          </div>
        );
      
      case 'loading':
        return (
          <div className="absolute inset-0 bg-gray-900 flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-4">📹</div>
              <div className="text-sm text-gray-400">H20N Display</div>
              <div className="text-xs text-gray-500 mt-2">Secondary camera stream</div>
            </div>
          </div>
        );

      case 'receiving':
        return (
          <div className="absolute inset-0 bg-gray-900 flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-4 animate-pulse">📡</div>
              <div className="text-lg text-dji-blue">Receiving H20N Stream</div>
              <div className="text-sm text-gray-400 mt-2">
                {frameStats.frames} frames received
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Secondary camera decoder initializing...
              </div>
            </div>
          </div>
        );

      case 'decoding':
        return (
          <div className="absolute inset-0 bg-gray-900 flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-4 animate-pulse">🎬</div>
              <div className="text-lg text-dji-blue">Decoding H20N Stream</div>
              <div className="text-sm text-gray-400 mt-2">
                {frameStats.frames} received • {frameStats.decodedFrames} decoded
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Secondary camera using WebCodecs
              </div>
            </div>
          </div>
        );
      
      case 'error':
        const errorMessage = decoderSupported === false 
          ? 'WebCodecs not supported in this browser'
          : 'Check bridge connection and H20N camera status';
          
        return (
          <div className="absolute inset-0 bg-dji-dark bg-opacity-80 flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-4 text-status-error">⚠️</div>
              <div className="text-lg text-status-error">H20N Stream Error</div>
              <div className="text-sm text-gray-500 mt-2">
                {errorMessage}
              </div>
              {decoderSupported === false && (
                <div className="text-xs text-gray-500 mt-2">
                  Try Chrome 94+ or Edge 94+ for WebCodecs support
                </div>
              )}
            </div>
          </div>
        );
      
      case 'playing':
      default:
        return null;
    }
  };

  return (
    <div ref={containerRef} className={`relative bg-dji-dark ${className}`}>
      <canvas
        ref={canvasRef}
        className="w-full h-full object-contain"
      />
      
      {/* Video content overlay area - matches actual video display rectangle */}
      <div 
        className="absolute"
        style={{
          left: `${displayRect.left}px`,
          top: `${displayRect.top}px`,
          width: `${displayRect.width}px`,
          height: `${displayRect.height}px`
        }}
      >
          {/* Only show error overlay when there's actually an error */}
          {videoStatus === 'error' && getStatusOverlay()}
          
          {/* Video info overlay - always show when we have frames */}
          {frameStats.decodedFrames > 0 && (
            <div className="absolute top-4 right-4 glass-panel p-2 text-xs">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-status-good rounded-full animate-pulse-blue"></div>
                <span>LIVE H20N</span>
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {frameStats.decodedFrames} frames decoded
              </div>
            </div>
          )}
          
          {/* Camera settings overlay */}
          <div className="absolute bottom-4 left-4 glass-panel p-3 text-sm">
            <div className="flex items-center gap-4">
              <div>
                <span className="text-gray-400">Camera: </span>
                <span className="text-white">H20N</span>
              </div>
              <div>
                <span className="text-gray-400">Source: </span>
                <span className="text-white">Secondary</span>
              </div>
              <div>
                <span className="text-gray-400">Lens: </span>
                <span className="text-white">Zoom</span>
              </div>
              <div>
                <span className="text-gray-400">Quality: </span>
                <span className="text-white">4K</span>
              </div>
            </div>
          </div>
          
          {/* Custom overlays passed as children */}
          {children}
      </div>
    </div>
  );
};