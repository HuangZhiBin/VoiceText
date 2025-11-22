import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, FunctionDeclaration, Type } from '@google/genai';
import { Mic, Globe, StopCircle, Trash2, Activity, ChevronDown, Check, ImageIcon } from 'lucide-react';
import { ConnectionStatus, TranscriptItem, LanguageOption } from './types';
import { createPcmBlob, decodeAudioData, AUDIO_WORKLET_CODE } from './utils/audio';
import AudioVisualizer from './components/AudioVisualizer';

const API_KEY = process.env.API_KEY;

const LANGUAGES: LanguageOption[] = [
  { code: 'none', name: 'Transcribe (Original)', flag: '🎙️' },
  { code: 'zh', name: 'Chinese', flag: '🇨🇳' },
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'ko', name: 'Korean', flag: '🇰🇷' },
  { code: 'de', name: 'German', flag: '🇩🇪' },
];

const MAX_RETRIES = 3;

// Tool definition for Image Generation
const renderImageTool: FunctionDeclaration = {
  name: 'render_image',
  description: 'Generate an image based on a user request or description.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: {
        type: Type.STRING,
        description: 'The detailed description of the image to generate.',
      },
    },
    required: ['prompt'],
  },
};

const App: React.FC = () => {
  // State
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [currentInput, setCurrentInput] = useState<string>('');
  const [currentOutput, setCurrentOutput] = useState<string>('');
  const [selectedLang, setSelectedLang] = useState<string>('none');
  const [isLangMenuOpen, setIsLangMenuOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Audio Analyser State (Persistent)
  const [audioAnalyser, setAudioAnalyser] = useState<AnalyserNode | null>(null);
  
  // Refs for Global Audio Context (Persistent across sessions)
  const globalAudioContextRef = useRef<AudioContext | null>(null);
  const globalAnalyserRef = useRef<AnalyserNode | null>(null);
  const isWorkletLoadedRef = useRef<boolean>(false);

  // Refs for Session Specifics
  const sessionRef = useRef<any>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  // Output Audio Context (for playback)
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const scrollRef = useRef<HTMLDivElement>(null);

  // Refs for real-time transcript accumulation
  const currentTurnInputRef = useRef('');
  const currentTurnOutputRef = useRef('');

  // Refs for Reconnection Logic
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryCountRef = useRef<number>(0);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcripts, currentInput, currentOutput]);

  // Initialize Audio Context Only Once
  const initAudioContext = async () => {
    if (globalAudioContextRef.current) {
      if (globalAudioContextRef.current.state === 'suspended') {
        await globalAudioContextRef.current.resume();
      }
      return globalAudioContextRef.current;
    }

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioContextClass();
    
    if (!ctx.audioWorklet) {
       throw new Error("AudioWorklet not supported");
    }

    // Create and configure Analyser once
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.1;
    globalAnalyserRef.current = analyser;
    setAudioAnalyser(analyser); // Triggers visualizer mount

    globalAudioContextRef.current = ctx;
    await ctx.resume();
    return ctx;
  };

  // Cleanup Function (Stops session, preserves context)
  const stopSession = useCallback(async (fullDisconnect = false) => {
    // Clear timers
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // 1. Stop Media Stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    // 2. Disconnect Worklet & Source
    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }

    // 3. Stop Output Audio
    audioSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;

    // 4. Suspend Global Context (Save resources)
    if (globalAudioContextRef.current && globalAudioContextRef.current.state === 'running') {
       try { await globalAudioContextRef.current.suspend(); } catch (e) {}
    }

    // 5. Clean Session Refs
    sessionRef.current = null;
    
    // CRITICAL FIX: Save any pending partial text to history before clearing
    const pendingInput = currentTurnInputRef.current.trim();
    const pendingOutput = currentTurnOutputRef.current.trim();
    const now = new Date();

    if (pendingInput || pendingOutput) {
      setTranscripts(prev => {
        const newItems = [...prev];
        if (pendingInput) {
          newItems.push({
            id: Date.now() + '-saved-input',
            role: 'user',
            text: pendingInput,
            isFinal: true,
            timestamp: now
          });
        }
        if (pendingOutput) {
          newItems.push({
            id: Date.now() + '-saved-output',
            role: 'model',
            text: pendingOutput,
            isFinal: true,
            timestamp: now
          });
        }
        return newItems;
      });
    }

    // Reset UI partials
    setCurrentInput('');
    setCurrentOutput('');
    currentTurnInputRef.current = '';
    currentTurnOutputRef.current = '';
    
    if (fullDisconnect) {
      setStatus(ConnectionStatus.DISCONNECTED);
    }
  }, []);

  const getSystemInstruction = (langCode: string) => {
    const lang = LANGUAGES.find(l => l.code === langCode);
    if (langCode === 'none') {
      return "You are a helpful assistant. Your primary task is to listen to the user. If the user speaks, simply acknowledge it or answer briefly. You can also generate images if the user asks to 'draw' or 'generate an image' by using the render_image tool. Be concise.";
    }
    return `You are an expert simultaneous interpreter. Translate the user's speech into ${lang?.name}. Output ONLY the translated text and speak it naturally. Do not add conversational filler.`;
  };

  const handleDisconnect = async () => {
    retryCountRef.current = 0;
    await stopSession(true);
  };

  // Generate Image Helper
  const generateImageContent = async (prompt: string) => {
    try {
      if (!API_KEY) return;
      const ai = new GoogleGenAI({ apiKey: API_KEY });
      
      setTranscripts(prev => [...prev, {
        id: Date.now() + '-generating',
        role: 'model',
        text: `Generating image: "${prompt}"...`,
        isFinal: true,
        timestamp: new Date()
      }]);

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: prompt }] },
      });

      let imageBase64 = null;
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
           imageBase64 = part.inlineData.data;
           break;
        }
      }

      if (imageBase64) {
         setTranscripts(prev => [...prev, {
            id: Date.now() + '-image',
            role: 'model',
            text: `Here is an image of: ${prompt}`,
            image: `data:image/png;base64,${imageBase64}`,
            isFinal: true,
            timestamp: new Date()
         }]);
         return "Image generated successfully and displayed to the user.";
      } else {
        return "Failed to generate image.";
      }

    } catch (e) {
      console.error("Image generation failed", e);
      return "Error occurred while generating image.";
    }
  };

  const onMessageReceived = useCallback(async (message: LiveServerMessage) => {
    const inputTxt = message.serverContent?.inputTranscription?.text;
    if (inputTxt) {
      currentTurnInputRef.current += inputTxt;
      setCurrentInput(currentTurnInputRef.current);
    }

    const outputTxt = message.serverContent?.outputTranscription?.text;
    if (outputTxt) {
      currentTurnOutputRef.current += outputTxt;
      setCurrentOutput(currentTurnOutputRef.current);
    }

    if (message.toolCall) {
      for (const fc of message.toolCall.functionCalls) {
        if (fc.name === 'render_image') {
          const prompt = (fc.args as any).prompt;
          const result = await generateImageContent(prompt);
          
          if (sessionRef.current) {
            sessionRef.current.sendToolResponse({
              functionResponses: {
                id: fc.id,
                name: fc.name,
                response: { result: result }
              }
            });
          }
        }
      }
    }

    if (message.serverContent?.turnComplete) {
      const now = new Date();
      const finalInput = currentTurnInputRef.current.trim();
      const finalOutput = currentTurnOutputRef.current.trim();
      
      if (finalInput) {
        setTranscripts(prev => [...prev, {
          id: Date.now() + '-user',
          role: 'user',
          text: finalInput,
          isFinal: true,
          timestamp: now
        }]);
        currentTurnInputRef.current = '';
        setCurrentInput('');
      }

      if (finalOutput) {
        setTranscripts(prev => [...prev, {
          id: Date.now() + '-model',
          role: 'model',
          text: finalOutput,
          isFinal: true,
          timestamp: now
        }]);
        currentTurnOutputRef.current = '';
        setCurrentOutput('');
      }
    }

    if (message.serverContent?.interrupted) {
      currentTurnOutputRef.current = '';
      setCurrentOutput('');
      audioSourcesRef.current.forEach(source => {
        try { source.stop(); } catch (e) {}
      });
      audioSourcesRef.current.clear();
      nextStartTimeRef.current = 0;
    }
  }, []);

  const startSession = async () => {
    if (!API_KEY) {
      setErrorMsg("API Key is missing in environment variables.");
      return;
    }
    
    setErrorMsg(null);
    setStatus(ConnectionStatus.CONNECTING);

    try {
      // 1. Initialize Shared Audio Context
      const inputCtx = await initAudioContext();
      
      // Initialize Output Context for playback (can be separate or same, keeping separate for simplicity with decoding)
      if (!outputAudioContextRef.current || outputAudioContextRef.current.state === 'closed') {
         const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
         outputAudioContextRef.current = new AudioContextClass();
      }
      await outputAudioContextRef.current.resume();

      // 2. Load Audio Worklet (Once)
      if (!isWorkletLoadedRef.current) {
        const blob = new Blob([AUDIO_WORKLET_CODE], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        try {
          await inputCtx.audioWorklet.addModule(workletUrl);
          isWorkletLoadedRef.current = true;
        } catch (e) {
           console.warn("Worklet addModule error (likely already loaded):", e);
           isWorkletLoadedRef.current = true; // Assume loaded if it fails usually
        }
      }

      // 3. Get Mic Stream
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
            channelCount: 1,
            echoCancellation: true,
            autoGainControl: true,
            noiseSuppression: true
        } 
      });
      mediaStreamRef.current = stream;

      // 4. Create Graph Nodes
      const source = inputCtx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(inputCtx, 'recorder-processor');
      
      // Store Refs
      sourceNodeRef.current = source;
      workletNodeRef.current = workletNode;

      // 5. Connect Graph: Source -> Analyser -> Worklet -> Destination
      // We use the globalAnalyserRef which is already attached to state
      if (globalAnalyserRef.current) {
        source.connect(globalAnalyserRef.current);
        globalAnalyserRef.current.connect(workletNode);
      } else {
        // Fallback if something weird happened
        source.connect(workletNode);
      }
      workletNode.connect(inputCtx.destination);

      // 6. Handle Data
      workletNode.port.onmessage = (event) => {
        if (!sessionRef.current) return;
        const inputData = event.data;
        const pcmBlob = createPcmBlob(inputData);
        sessionRef.current.sendRealtimeInput({ media: pcmBlob }).catch(() => {});
      };

      // 7. Connect Gemini
      const ai = new GoogleGenAI({ apiKey: API_KEY });
      const instruction = getSystemInstruction(selectedLang);

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          },
          systemInstruction: instruction,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [{ functionDeclarations: [renderImageTool] }],
        },
        callbacks: {
          onopen: () => {
             console.log("Session Connected");
             setStatus(ConnectionStatus.CONNECTED);
             sessionPromise.then(sess => sessionRef.current = sess);
             retryCountRef.current = 0; 
          },
          onmessage: (msg) => {
             onMessageReceived(msg);

             // Audio Playback
             const base64Audio = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
             if (base64Audio && outputAudioContextRef.current) {
                const ctx = outputAudioContextRef.current;
                const startTime = Math.max(nextStartTimeRef.current, ctx.currentTime);

                // console.log("base64Audio="+base64Audio);
                
                decodeAudioData(base64Audio, ctx, 24000).then(buffer => {
                   const source = ctx.createBufferSource();
                   source.buffer = buffer;
                   source.connect(ctx.destination);
                   source.start(startTime);
                   nextStartTimeRef.current = startTime + buffer.duration;
                   audioSourcesRef.current.add(source);
                   source.onended = () => audioSourcesRef.current.delete(source);
                }).catch(console.error);
             }
          },
          onclose: (e) => {
            console.log("Session Closed", e);
            // If closed by server, just stop. 
            // If closed manually, handleDisconnect handles state.
            if (status !== ConnectionStatus.DISCONNECTED) {
                 stopSession(true);
            }
          },
          onerror: (err) => {
            console.error("Session error:", err);
            const message = err instanceof Error ? err.message : "Connection lost";
            
            if (retryCountRef.current < MAX_RETRIES) {
              const nextRetry = retryCountRef.current + 1;
              setStatus(ConnectionStatus.CONNECTING);
              setErrorMsg(`Connection lost. Reconnecting (${nextRetry}/${MAX_RETRIES})...`);
              retryCountRef.current = nextRetry;

              stopSession(false).then(() => {
                reconnectTimeoutRef.current = setTimeout(() => {
                  startSession();
                }, 2000);
              });
            } else {
              setErrorMsg(message + " (Max retries reached)");
              setStatus(ConnectionStatus.ERROR);
              stopSession(false);
            }
          }
        }
      });

    } catch (e: any) {
      console.error("Failed to start session:", e);
      setErrorMsg(e.message || "Failed to access microphone or connect.");
      setStatus(ConnectionStatus.ERROR);
      stopSession(false);
    }
  };

  const handleLanguageChange = async (code: string) => {
    setSelectedLang(code);
    setIsLangMenuOpen(false);
    if (status === ConnectionStatus.CONNECTED) {
      await handleDisconnect();
      // Optional: Auto-restart with new language
      // startSession(); 
    }
  };

  const activeLang = LANGUAGES.find(l => l.code === selectedLang);

  return (
    <div className="h-screen bg-slate-950 text-slate-100 flex flex-col relative overflow-hidden font-sans selection:bg-blue-500/30">
      
      {/* FIXED HEADER */}
      <header className="flex-none w-full p-6 z-20 bg-slate-950/80 backdrop-blur-md border-b border-slate-800/50 flex justify-center">
        <div className="w-full max-w-3xl flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2.5 rounded-xl shadow-lg shadow-blue-900/20">
              <Activity size={24} className="text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">LinguaFlow Live</h1>
              <p className="text-xs text-slate-400 font-medium">Real-time Translation & Transcription</p>
            </div>
          </div>

          <div className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-2 border backdrop-blur-md transition-all duration-300 ${
            status === ConnectionStatus.CONNECTED 
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.2)]' 
              : status === ConnectionStatus.CONNECTING 
              ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' 
              : status === ConnectionStatus.ERROR
              ? 'bg-red-500/10 text-red-400 border-red-500/20'
              : 'bg-slate-800/50 text-slate-400 border-slate-700'
          }`}>
            <div className={`w-2 h-2 rounded-full ${
              status === ConnectionStatus.CONNECTED ? 'bg-emerald-400 animate-pulse' : 
              status === ConnectionStatus.CONNECTING ? 'bg-amber-400 animate-bounce' : 
              status === ConnectionStatus.ERROR ? 'bg-red-500' : 'bg-slate-500'
            }`} />
            {status === ConnectionStatus.DISCONNECTED ? 'READY' : status === ConnectionStatus.CONNECTED ? 'LIVE' : status.toUpperCase()}
          </div>
        </div>
      </header>

      {/* SCROLLABLE CONTENT */}
      <main className="flex-1 overflow-y-auto relative z-10 w-full">
        <div className="w-full max-w-3xl mx-auto px-4 py-6">
          {/* Error Banner */}
          {errorMsg && (
             <div className="w-full mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm text-center animate-pulse flex items-center justify-center gap-2">
                <span>⚠️</span> {errorMsg}
             </div>
          )}

          {/* Empty State */}
          {transcripts.length === 0 && !currentInput && (
            <div className="h-[60vh] flex flex-col items-center justify-center text-slate-600">
              <div className="w-24 h-24 rounded-full bg-slate-900/50 flex items-center justify-center mb-6 border border-slate-800 shadow-inner">
                 <Globe size={48} className="text-slate-700" />
              </div>
              <p className="text-xl font-medium text-slate-500">Select a language and start speaking</p>
              <p className="text-sm text-slate-600 mt-2">Ask "Draw a cat" to generate images</p>
            </div>
          )}

          {/* Transcripts */}
          <div className="space-y-6">
            {transcripts.map((item) => (
              <div key={item.id} className={`flex w-full ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] flex flex-col gap-1 ${item.role === 'user' ? 'items-end' : 'items-start'}`}>
                  
                  {/* Text Bubble */}
                  <div className={`px-5 py-3.5 rounded-2xl text-[15px] leading-relaxed shadow-sm whitespace-pre-wrap break-words ${
                    item.role === 'user' 
                    ? 'bg-blue-600 text-white rounded-tr-sm' 
                    : 'bg-slate-800 text-slate-200 rounded-tl-sm border border-slate-700'
                  }`}>
                    {item.text}
                  </div>

                  {/* Image Display */}
                  {item.image && (
                    <div className="mt-2 rounded-xl overflow-hidden border border-slate-700 shadow-lg">
                       <img src={item.image} alt="Generated content" className="max-w-full h-auto max-h-[400px] object-contain bg-black" />
                       <div className="px-3 py-1.5 bg-slate-900/80 text-xs text-slate-400 flex items-center gap-1">
                          <ImageIcon size={12} />
                          Generated with Gemini
                       </div>
                    </div>
                  )}

                  <span className="text-[10px] text-slate-500 font-medium px-1">
                    {item.role === 'user' ? 'You' : activeLang?.code === 'none' ? 'Gemini' : 'Translation'}
                  </span>
                </div>
              </div>
            ))}

            {/* Real-time partials */}
            {currentInput && (
              <div className="flex w-full justify-end">
                 <div className="max-w-[85%] flex flex-col gap-1 items-end">
                   <div className="px-5 py-3.5 rounded-2xl rounded-tr-sm bg-blue-600/80 text-white/90 italic border border-blue-500/50 whitespace-pre-wrap break-words">
                      {currentInput} <span className="animate-pulse inline-block w-1 h-4 bg-white/50 align-middle ml-1"/>
                   </div>
                   <span className="text-[10px] text-slate-500 font-medium px-1">Listening...</span>
                 </div>
              </div>
            )}
            
            {currentOutput && (
              <div className="flex w-full justify-start">
                 <div className="max-w-[85%] flex flex-col gap-1 items-start">
                   <div className="px-5 py-3.5 rounded-2xl rounded-tl-sm bg-slate-800/80 text-slate-300 italic border border-slate-700/50 whitespace-pre-wrap break-words">
                      {currentOutput} <span className="animate-pulse inline-block w-1 h-4 bg-slate-400/50 align-middle ml-1"/>
                   </div>
                   <span className="text-[10px] text-slate-500 font-medium px-1">Processing...</span>
                 </div>
              </div>
            )}
            <div ref={scrollRef} className="h-4" />
          </div>
        </div>
      </main>

      {/* FIXED FOOTER (Controls + Visualizer) */}
      <div className="flex-none w-full bg-slate-950 border-t border-slate-800 z-50 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
         <div className="w-full max-w-3xl mx-auto px-4 pb-6 pt-2">
            
            {/* Visualizer Area */}
            <div className="relative w-full h-16 bg-slate-900/50 rounded-xl border border-slate-800/60 backdrop-blur-sm overflow-hidden flex items-center justify-center mb-4 shrink-0 shadow-inner mt-2">
              <AudioVisualizer 
                isActive={status === ConnectionStatus.CONNECTED || status === ConnectionStatus.CONNECTING} 
                analyser={audioAnalyser} 
              />
              
              {!API_KEY && (
                 <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 z-20 backdrop-blur-[2px]">
                     <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-mono">
                        MISSING_API_KEY
                     </div>
                 </div>
              )}
            </div>

            {/* Controls Bar */}
            <div className="w-full bg-slate-900/80 border border-slate-800 rounded-3xl p-2.5 flex items-center justify-between backdrop-blur-xl relative z-20">
              
              {/* Left: Language Selector */}
              <div className="relative">
                 <button 
                   onClick={() => setIsLangMenuOpen(!isLangMenuOpen)}
                   disabled={status === ConnectionStatus.CONNECTING}
                   className="flex items-center gap-2 px-4 py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-200 transition-all border border-slate-700/50 hover:border-slate-600 disabled:opacity-50"
                 >
                    <span className="text-lg">{activeLang?.flag}</span>
                    <span className="text-sm font-medium hidden sm:inline-block">{activeLang?.name}</span>
                    <ChevronDown size={16} className={`text-slate-400 transition-transform duration-200 ${isLangMenuOpen ? 'rotate-180' : ''}`} />
                 </button>

                 {isLangMenuOpen && (
                   <div className="absolute bottom-full left-0 mb-3 w-64 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden py-2 z-50">
                      <div className="px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">Target Language</div>
                      {LANGUAGES.map(lang => (
                        <button
                          key={lang.code}
                          onClick={() => handleLanguageChange(lang.code)}
                          className={`w-full px-4 py-3 flex items-center justify-between hover:bg-slate-800 transition-colors text-left ${selectedLang === lang.code ? 'bg-blue-900/20 text-blue-400' : 'text-slate-300'}`}
                        >
                           <div className="flex items-center gap-3">
                             <span className="text-lg">{lang.flag}</span>
                             <span className="text-sm font-medium">{lang.name}</span>
                           </div>
                           {selectedLang === lang.code && <Check size={16} />}
                        </button>
                      ))}
                   </div>
                 )}
              </div>

              {/* Center: Main Action */}
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                {status === ConnectionStatus.CONNECTED ? (
                  <button 
                    onClick={handleDisconnect}
                    className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white shadow-[0_0_20px_rgba(239,68,68,0.4)] hover:shadow-[0_0_30px_rgba(239,68,68,0.6)] transition-all transform hover:scale-105 active:scale-95 group"
                  >
                     <StopCircle size={28} fill="currentColor" className="group-hover:scale-110 transition-transform" />
                  </button>
                ) : (
                  <button 
                    onClick={startSession}
                    disabled={!API_KEY || status === ConnectionStatus.CONNECTING}
                    className="w-16 h-16 rounded-full bg-blue-600 hover:bg-blue-500 flex items-center justify-center text-white shadow-[0_0_20px_rgba(37,99,235,0.4)] hover:shadow-[0_0_30px_rgba(37,99,235,0.6)] transition-all transform hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
                  >
                     {status === ConnectionStatus.CONNECTING ? (
                       <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                     ) : (
                       <Mic size={28} className="hover:animate-pulse" />
                     )}
                  </button>
                )}
              </div>

              {/* Right: Utility */}
              <div className="flex items-center gap-2">
                 <button 
                   onClick={() => {
                     setTranscripts([]);
                     setCurrentInput('');
                     setCurrentOutput('');
                   }}
                   className="p-3 rounded-xl bg-slate-800/50 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors border border-transparent hover:border-slate-700"
                   title="Clear Transcript"
                 >
                   <Trash2 size={18} />
                 </button>
              </div>

            </div>
         </div>
      </div>

      {/* Ambient Background */}
      <div className="absolute inset-0 pointer-events-none z-0">
         <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-blue-600/10 rounded-full blur-[120px]" />
         <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-purple-600/10 rounded-full blur-[120px]" />
      </div>
    </div>
  );
};

export default App;