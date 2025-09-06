import React, { useRef, useEffect, useState } from 'react';
import { FPVDisplayProps } from '../types';

export const FPVDisplay: React.FC<FPVDisplayProps> = ({ 
  width, 
  height, 
  className = '',
  children
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoDecoderRef = useRef<VideoDecoder | null>(null);
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
          console.log('✅ H.264 WebCodecs decoding supported');
          setDecoderSupported(true);
          return true;
        } else {
          console.warn('❌ H.264 WebCodecs decoding not supported');
          setDecoderSupported(false);
          setVideoStatus('error');
          return false;
        }
      } catch (error) {
        console.error('Error checking WebCodecs support:', error);
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

        // Create the decoder (but don't configure until we have SPS/PPS)
        videoDecoderRef.current = new VideoDecoder({
          output: (frame: VideoFrame) => {
            try {
              // Update video dimensions if changed
              if (videoDimensions.width !== frame.codedWidth || videoDimensions.height !== frame.codedHeight) {
                setVideoDimensions({ width: frame.codedWidth, height: frame.codedHeight });
              }
              
              // Draw the decoded frame to canvas
              if (canvas.width !== frame.codedWidth || canvas.height !== frame.codedHeight) {
                canvas.width = frame.codedWidth;
                canvas.height = frame.codedHeight;
              }
              
              // Clear canvas and draw frame
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(frame, 0, 0);
              frame.close();
              
              // Update stats  
              setFrameStats(prev => ({
                ...prev,
                decodedFrames: prev.decodedFrames + 1
              }));
              
              // Change to playing state on first frame
              if (frameStats.decodedFrames === 0) {
                setVideoStatus('playing');
              }
              
            } catch (error) {
              console.error('Error drawing video frame:', error);
              frame.close();
            }
          },
          error: (error: Error) => {
            console.error('VideoDecoder error:', error);
            console.error('Decoder state:', videoDecoderRef.current?.state);
            console.error('Error details:', {
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
        };

      } catch (error) {
        console.error('Failed to set up video decoder:', error);
        setVideoStatus('error');
      }
    };

    // Handle incoming video frames - new format with metadata + binary data
    const handleVideoFrame = (frameInfo: any) => {
      if (!frameInfo) return;
      
      // Handle new format: { metadata: {...}, data: Buffer }
      const frameData = frameInfo.data;
      const metadata = frameInfo.metadata;
      
      if (!frameData) {
        console.warn('FPVDisplay: Received video frame without data');
        return;
      }
      
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
          console.error('Unsupported video data format:', typeof frameData);
          return;
        }

        if (h264Data.length === 0) {
          console.warn('Empty video frame, skipping');
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
            console.log('Decoder is closed, skipping configuration until recreated');
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
            console.error('❌ Failed to configure decoder:', error);
            decoderConfiguredRef.current = false;
            setVideoStatus('error');
            return;
          }
        }

        // Skip if decoder not configured or closed
        if (!decoderConfiguredRef.current || !videoDecoderRef.current || videoDecoderRef.current.state !== 'configured') {
          if (videoDecoderRef.current && videoDecoderRef.current.state === 'closed') {
            console.log('Decoder closed, triggering recreation');
            decoderConfiguredRef.current = false;
            // Trigger recreation on next frame
            setTimeout(() => setupVideoDecoder(), 100);
          }
          return;
        }

        // Determine if this is a keyframe
        const isKey = isKeyFrame(nalUnits);
        //console.log(`Frame type: ${isKey ? 'KEY' : 'DELTA'} frame`);

        // Skip non-key frames if decoder just configured (wait for next I-frame)
        if (!isKey && videoStatus === 'decoding') {
          //console.log('Skipping P-frame, waiting for next I-frame after configuration');
          return;
        }

        // Create EncodedVideoChunk for WebCodecs
        try {
          //console.log(`Creating chunk: type=${isKey ? 'key' : 'delta'}, size=${h264Data.length}, timestamp=${now * 1000}`);
          const chunk = new EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: now * 1000, // Convert to microseconds
            data: h264Data
          });

          // Only set to 'decoding' if we're not already playing
          if (videoStatus !== 'playing') {
            setVideoStatus('decoding');
          }
          
          //console.log(`Decoding chunk with decoder state: ${videoDecoderRef.current.state}`);
          videoDecoderRef.current.decode(chunk);
          //console.log('Decode call successful');
        } catch (decodeError) {
          console.error('Decode error:', decodeError);
          console.error('Decode error details:', {
            name: decodeError.name,
            message: decodeError.message,
            decoderState: videoDecoderRef.current?.state
          });
          
          // If this was a key frame and it failed, reset the decoder
          if (isKey) {
            console.log('Key frame decode failed, resetting decoder...');
            decoderConfiguredRef.current = false;
            spsRef.current = null;
            ppsRef.current = null;
            
            // Close and recreate decoder
            if (videoDecoderRef.current) {
              try {
                // Close the decoder regardless of current state
                videoDecoderRef.current.close();
              } catch (closeError) {
                console.warn('Error closing decoder:', closeError);
              }
            }
            
            // Trigger decoder recreation on next frame
            setTimeout(() => setupVideoDecoder(), 100);
          }
        }
        
      } catch (error) {
        console.error('Failed to decode video frame:', error);
        setVideoStatus('error');
        // Reset decoder state on error
        decoderConfiguredRef.current = false;
      }
    };

    setupVideoDecoder();

    // Listen for video frames from main process
    window.electronAPI.onVideoFrame(handleVideoFrame);

    return () => {
      cleanup?.();
      window.electronAPI.removeAllListeners('video-frame');
    };
  }, []);

  const getStatusOverlay = () => {
    switch (videoStatus) {
      case 'waiting':
        return (
          <div className="absolute inset-0 bg-dji-dark bg-opacity-80 flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-4">📹</div>
              <div className="text-lg text-gray-300">Waiting for Video Stream</div>
              <div className="text-sm text-gray-500 mt-2">
                Make sure camera is active on controller
              </div>
            </div>
          </div>
        );
      
      case 'loading':
        return (
          <div className="absolute inset-0 bg-gray-900 flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-4">📹</div>
              <div className="text-sm text-gray-400">Video Display</div>
              <div className="text-xs text-gray-500 mt-2">Phase 3B - H.264 streaming ready</div>
            </div>
          </div>
        );

      case 'receiving':
        return (
          <div className="absolute inset-0 bg-gray-900 flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-4 animate-pulse">📡</div>
              <div className="text-lg text-dji-blue">Receiving H.264 Stream</div>
              <div className="text-sm text-gray-400 mt-2">
                {frameStats.frames} frames received
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Waiting for decoder to be ready...
              </div>
            </div>
          </div>
        );

      case 'decoding':
        return (
          <div className="absolute inset-0 bg-gray-900 flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-4 animate-pulse">🎬</div>
              <div className="text-lg text-dji-blue">Decoding H.264 Stream</div>
              <div className="text-sm text-gray-400 mt-2">
                {frameStats.frames} received • {frameStats.decodedFrames} decoded
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Using WebCodecs API for hardware acceleration
              </div>
            </div>
          </div>
        );
      
      case 'error':
        const errorMessage = decoderSupported === false 
          ? 'WebCodecs not supported in this browser'
          : 'Check bridge connection and camera status';
          
        return (
          <div className="absolute inset-0 bg-dji-dark bg-opacity-80 flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-4 text-status-error">⚠️</div>
              <div className="text-lg text-status-error">Video Stream Error</div>
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
          {getStatusOverlay()}
          
          {/* Video info overlay */}
          {videoStatus === 'playing' && (
            <div className="absolute top-4 right-4 glass-panel p-2 text-xs">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-status-good rounded-full animate-pulse-blue"></div>
                <span>LIVE H.264</span>
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
                <span className="text-gray-400">Mode: </span>
                <span className="text-white">Video</span>
              </div>
              <div>
                <span className="text-gray-400">Lens: </span>
                <span className="text-white">Wide</span>
              </div>
              <div>
                <span className="text-gray-400">ISO: </span>
                <span className="text-white">AUTO</span>
              </div>
              <div>
                <span className="text-gray-400">Quality: </span>
                <span className="text-white">4K/60</span>
              </div>
            </div>
          </div>
          
          {/* Custom overlays passed as children */}
          {children}
      </div>
    </div>
  );
};
