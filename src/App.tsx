import { useState, useEffect, useRef, FormEvent, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Circle, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { MapPin, Bell, Search, Loader2, Navigation, VolumeX, Crosshair, X, Trash2, Check, Sliders, Mic } from 'lucide-react';
import { parseAlarmText } from './lib/gemini';
import { useGeolocation, calculateDistance } from './lib/geolocation';
import { AlarmPlayer } from './lib/audio';
import { motion, AnimatePresence } from 'motion/react';

// Fix Leaflet marker icons - removing default shadow to prevent "pink symbols"
// @ts-ignore
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
// @ts-ignore
import markerIcon from 'leaflet/dist/images/marker-icon.png';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: '', // Explicitly remove shadow
});

const defaultCenter: [number, number] = [37.7749, -122.4194];

interface Alarm {
  id: string;
  targetLocation: [number, number];
  targetName: string;
  radiusMeters: number;
  triggered: boolean;
}

// Component to handle map view updates and interactions
function MapController({ 
  target, 
  userLocation, 
  shouldFollowUser, 
  onMapMove,
  onMapClick,
  draftLocation,
  draftRadius
}: { 
  target: [number, number] | null, 
  userLocation: { lat: number, lng: number } | null,
  shouldFollowUser: boolean,
  onMapMove: () => void,
  onMapClick: (lat: number, lng: number) => void,
  draftLocation: [number, number] | null,
  draftRadius: number
}) {
  const map = useMap();
  const hasInitialCentered = useRef(false);

  useMapEvents({
    click(e) {
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
    dragstart() {
      onMapMove();
    }
  });

  // Initial center on user
  useEffect(() => {
    if (userLocation && !hasInitialCentered.current) {
      map.setView([userLocation.lat, userLocation.lng], 13);
      hasInitialCentered.current = true;
    }
  }, [userLocation, map]);

  // Follow user logic (only if explicitly requested)
  useEffect(() => {
    if (shouldFollowUser && userLocation) {
      map.setView([userLocation.lat, userLocation.lng], map.getZoom());
    }
  }, [shouldFollowUser, userLocation, map]);

  // Zoom to target or draft when set
  useEffect(() => {
    if (target) {
      const targetLatLng = L.latLng(target[0], target[1]);
      const bounds = L.latLngBounds(targetLatLng, targetLatLng);
      if (userLocation) {
        bounds.extend(L.latLng(userLocation.lat, userLocation.lng));
      }
      map.fitBounds(bounds, { padding: [100, 100], maxZoom: 15 });
    } else if (draftLocation) {
      const center = L.latLng(draftLocation[0], draftLocation[1]);
      
      // Calculate bounds manually to avoid Leaflet's map-dependency in circle.getBounds()
      // 1 degree of latitude is ~111,320 meters
      const dLat = draftRadius / 111320;
      const dLng = draftRadius / (111320 * Math.cos(center.lat * Math.PI / 180));
      
      const bounds = L.latLngBounds(
        [center.lat - dLat, center.lng - dLng],
        [center.lat + dLat, center.lng + dLng]
      );
      
      // Only auto-zoom if the circle is significantly outside the current view
      try {
        const currentBounds = map.getBounds();
        if (currentBounds && !currentBounds.contains(bounds)) {
          map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
        }
      } catch (e) {
        // Map might not be ready for getBounds()
        console.warn("Map not ready for bounds calculation", e);
      }
    }
  }, [target, draftLocation, draftRadius, map]);

  return null;
}

const formatRadius = (meters: number) => {
  return `${meters}m`;
};

export default function App() {
  const { location: userLocation, error: geoError, loading: geoLoading } = useGeolocation();
  const [inputText, setInputText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [shouldFollowUser, setShouldFollowUser] = useState(false);
  const [isSheetExpanded, setIsSheetExpanded] = useState(false);
  
  // Manual pin placement state
  const [draftLocation, setDraftLocation] = useState<[number, number] | null>(null);
  const [draftRadius, setDraftRadius] = useState(1000);
  const [selectedAlarmId, setSelectedAlarmId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<any>(null);

  // Initialize Speech Recognition
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;
      recognitionRef.current.lang = 'en-US';

      recognitionRef.current.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setInputText(transcript);
        setIsRecording(false);
        handleSearch(transcript);
      };

      recognitionRef.current.onerror = (event: any) => {
        console.error('Speech recognition error:', event.error);
        setIsRecording(false);
        
        if (event.error === 'not-allowed') {
          setSearchError('Microphone access denied. Please check site permissions or try opening in a new tab.');
        } else if (event.error === 'no-speech') {
          // Ignore no-speech errors as they are common and often handled by onend
        } else {
          setSearchError(`Voice recognition failed: ${event.error}. Please try again.`);
        }
      };

      recognitionRef.current.onend = () => {
        setIsRecording(false);
      };
    }
  }, []);

  const toggleRecording = () => {
    if (isRecording) {
      recognitionRef.current?.stop();
    } else {
      if (!recognitionRef.current) {
        setSearchError('Voice recognition not supported in this browser.');
        return;
      }
      setSearchError(null);
      setIsRecording(true);
      recognitionRef.current.start();
    }
  };

  // Autocomplete logic
  useEffect(() => {
    if (suggestionTimeoutRef.current) clearTimeout(suggestionTimeoutRef.current);

    if (inputText.length < 3) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    suggestionTimeoutRef.current = setTimeout(async () => {
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(inputText)}&limit=5`,
          { headers: { 'User-Agent': 'GeoAlarmAI/1.0' } }
        );
        if (response.ok) {
          const data = await response.json();
          setSuggestions(data);
          setShowSuggestions(data.length > 0);
        }
      } catch (err) {
        console.error("Autocomplete error:", err);
      }
    }, 500);

    return () => {
      if (suggestionTimeoutRef.current) clearTimeout(suggestionTimeoutRef.current);
    };
  }, [inputText]);

  const handleSelectSuggestion = (suggestion: any) => {
    setInputText(suggestion.display_name);
    setShowSuggestions(false);
    handleSearch(suggestion.display_name);
  };

  const handleSearch = async (query: string) => {
    setIsProcessing(true);
    setSearchError(null);
    try {
      let parsed;
      try {
        parsed = await parseAlarmText(query);
      } catch (err) {
        console.error("Gemini error:", err);
        setSearchError("AI failed to understand the request. Please try a simpler command.");
        return;
      }

      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(parsed.location)}&limit=1&addressdetails=1`,
          { headers: { 'User-Agent': 'GeoAlarmAI/1.0' } }
        );
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const results = await response.json();

        if (results && results.length > 0) {
          const loc = results[0];
          const newAlarm: Alarm = {
            id: Math.random().toString(36).substr(2, 9),
            targetLocation: [parseFloat(loc.lat), parseFloat(loc.lon)],
            targetName: parsed.location,
            radiusMeters: parsed.radiusMeters,
            triggered: false
          };
          setAlarms(prev => [...prev, newAlarm]);
          setAlarmTriggered(false);
          setShouldFollowUser(false);
          setSelectedAlarmId(null);
          setInputText('');
        } else {
          setSearchError(`Could not find "${parsed.location}". Try a more specific name.`);
        }
      } catch (err) {
        console.error("Nominatim error:", err);
        setSearchError("Network error: Failed to fetch location data. Please check your connection.");
      }
    } catch (err) {
      console.error("General search error:", err);
      setSearchError("Something went wrong. Please try again.");
    } finally {
      setIsProcessing(false);
    }
  };

  useEffect(() => {
    if (searchError) {
      const timer = setTimeout(() => setSearchError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [searchError]);
  
  const [alarms, setAlarms] = useState<Alarm[]>(() => {
    try {
      const saved = localStorage.getItem('geo_alarms');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.error("Failed to load alarms from localStorage", e);
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem('geo_alarms', JSON.stringify(alarms));
  }, [alarms]);

  const [activeAlarmId, setActiveAlarmId] = useState<string | null>(null);
  
  const [alarmTriggered, setAlarmTriggered] = useState(false);
  const alarmPlayerRef = useRef<AlarmPlayer | null>(null);

  // Custom icons
  const userIcon = useMemo(() => L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color: #3b82f6; width: 16px; height: 16px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 10px rgba(59, 130, 246, 0.5);"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  }), []);

  const targetIcon = useMemo(() => L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color: #f97316; width: 20px; height: 20px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 15px rgba(249, 115, 22, 0.5); display: flex; align-items: center; justify-content: center;"><div style="width: 6px; height: 6px; background-color: white; border-radius: 50%;"></div></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  }), []);

  const draftIcon = useMemo(() => L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color: #ffffff; width: 20px; height: 20px; border-radius: 50%; border: 2px solid #f97316; box-shadow: 0 0 15px rgba(255, 255, 255, 0.5); display: flex; align-items: center; justify-content: center;"><div style="width: 8px; height: 8px; background-color: #f97316; border-radius: 50%;"></div></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  }), []);

  // Initialize audio context on first user interaction for mobile compatibility
  useEffect(() => {
    const initAudio = () => {
      if (!alarmPlayerRef.current) {
        alarmPlayerRef.current = new AlarmPlayer();
      }
      // @ts-ignore - calling private method for initialization
      alarmPlayerRef.current.initCtx();
      window.removeEventListener('click', initAudio);
      window.removeEventListener('touchstart', initAudio);
    };
    window.addEventListener('click', initAudio);
    window.addEventListener('touchstart', initAudio);
    return () => {
      window.removeEventListener('click', initAudio);
      window.removeEventListener('touchstart', initAudio);
    };
  }, []);

  // Check distance for all alarms
  useEffect(() => {
    if (!userLocation) return;

    alarms.forEach(alarm => {
      if (!alarm.triggered) {
        const dist = calculateDistance(
          userLocation.lat,
          userLocation.lng,
          alarm.targetLocation[0],
          alarm.targetLocation[1]
        );
        
        if (dist <= alarm.radiusMeters) {
          triggerAlarm(alarm);
        }
      }
    });
  }, [userLocation, alarms]);

  const triggerAlarm = (alarm: Alarm) => {
    setAlarms(prev => prev.map(a => a.id === alarm.id ? { ...a, triggered: true } : a));
    setActiveAlarmId(alarm.id);
    setAlarmTriggered(true);
    
    if (!alarmPlayerRef.current) {
      alarmPlayerRef.current = new AlarmPlayer();
    }
    alarmPlayerRef.current.start();

    // Vibrate phone
    if ("vibrate" in navigator) {
      const startVibration = () => {
        navigator.vibrate([500, 200, 500, 200, 500]);
      };
      
      startVibration();
      const vibInterval = setInterval(() => {
        // We check the ref or a global state because the closure might have stale state
        if (document.getElementById('alarm-overlay')) {
          startVibration();
        } else {
          clearInterval(vibInterval);
        }
      }, 2000);
    }

    // Browser Notification
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("GeoAlarm Arrived!", {
        body: `You are within ${alarm.radiusMeters}m of ${alarm.targetName}.`,
        icon: "/favicon.ico"
      });
    } else if ("Notification" in window && Notification.permission !== "denied") {
      Notification.requestPermission();
    }
  };

  const handleStopAlarm = () => {
    if (alarmPlayerRef.current) {
      alarmPlayerRef.current.stop();
    }
    if ("vibrate" in navigator) {
      navigator.vibrate(0); // Stop vibration
    }
    setAlarmTriggered(false);
    if (activeAlarmId) {
      setAlarms(prev => prev.filter(a => a.id !== activeAlarmId));
      if (selectedAlarmId === activeAlarmId) setSelectedAlarmId(null);
      setActiveAlarmId(null);
    }
  };

  const removeAlarm = (id: string) => {
    setAlarms(prev => prev.filter(a => a.id !== id));
    if (selectedAlarmId === id) setSelectedAlarmId(null);
  };

  const handleConfirmDraft = async () => {
    if (!draftLocation) return;
    
    setIsProcessing(true);
    try {
      // Reverse geocode to get a name
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${draftLocation[0]}&lon=${draftLocation[1]}`,
        { headers: { 'User-Agent': 'GeoAlarmAI/1.0' } }
      );
      const data = await response.json();
      const name = data.display_name?.split(',')[0] || `Pinned Location (${draftLocation[0].toFixed(4)}, ${draftLocation[1].toFixed(4)})`;

      const newAlarm: Alarm = {
        id: Math.random().toString(36).substr(2, 9),
        targetLocation: draftLocation,
        targetName: name,
        radiusMeters: draftRadius,
        triggered: false
      };
      setAlarms(prev => [...prev, newAlarm]);
      setDraftLocation(null);
      setSelectedAlarmId(null);
    } catch (err) {
      console.error(err);
      setSearchError("Failed to set alarm at this location.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    setShowSuggestions(false);
    handleSearch(inputText);
  };

  const activeAlarms = alarms.filter(a => !a.triggered);

  return (
    <div className="relative w-full h-screen bg-[#0a0a0a] overflow-hidden font-sans text-white">
      {/* Loading Overlay */}
      <AnimatePresence>
        {geoLoading && !userLocation && !geoError && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[2000] bg-[#0a0a0a] flex flex-col items-center justify-center p-6 text-center"
          >
            <div className="relative mb-8">
              <div className="absolute inset-0 bg-blue-500/20 blur-3xl rounded-full animate-pulse"></div>
              <Navigation className="w-16 h-16 text-blue-500 animate-bounce relative z-10" />
            </div>
            <h2 className="text-2xl font-bold mb-2 tracking-tight">Finding your location...</h2>
            <p className="text-white/40 max-w-xs text-sm">
              We're connecting to your GPS to provide accurate distance alerts. This may take a few seconds.
            </p>
            <div className="mt-8 flex gap-1">
              {[0, 1, 2].map(i => (
                <motion.div
                  key={i}
                  className="w-2 h-2 bg-blue-500 rounded-full"
                  animate={{ opacity: [0.2, 1, 0.2] }}
                  transition={{ repeat: Infinity, duration: 1, delay: i * 0.2 }}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Map Background */}
      <div className="absolute inset-0 z-0">
        <MapContainer
          center={userLocation ? [userLocation.lat, userLocation.lng] : defaultCenter}
          zoom={13}
          style={{ width: '100%', height: '100%' }}
          zoomControl={false}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          
          {userLocation && (
            <Marker position={[userLocation.lat, userLocation.lng]} icon={userIcon} />
          )}
          
          {alarms.map(alarm => (
            <div key={alarm.id}>
              <Marker 
                position={alarm.targetLocation} 
                icon={targetIcon}
                eventHandlers={{
                  click: () => setSelectedAlarmId(alarm.id === selectedAlarmId ? null : alarm.id)
                }}
              />
              <Circle
                center={alarm.targetLocation}
                radius={alarm.radiusMeters}
                pathOptions={{
                  fillColor: alarm.triggered ? '#ef4444' : '#f97316',
                  fillOpacity: selectedAlarmId === alarm.id ? 0.3 : 0.1,
                  color: alarm.triggered ? '#ef4444' : '#f97316',
                  weight: selectedAlarmId === alarm.id ? 5 : 3,
                  opacity: 0.9,
                  className: 'glowing-circle'
                }}
              >
                {selectedAlarmId === alarm.id && (
                  <Tooltip permanent direction="top" className="radius-tooltip">
                    <div className="flex flex-col items-center gap-1">
                      <span className="font-bold">{alarm.targetName}</span>
                      <span className="text-[10px] opacity-80">{formatRadius(alarm.radiusMeters)}</span>
                    </div>
                  </Tooltip>
                )}
              </Circle>
            </div>
          ))}

          {draftLocation && (
            <>
              <Marker position={draftLocation} icon={draftIcon} />
              <Circle
                center={draftLocation}
                radius={draftRadius}
                pathOptions={{
                  fillColor: '#f97316',
                  fillOpacity: 0.1,
                  color: '#f97316',
                  weight: 3,
                  opacity: 0.9,
                  className: 'glowing-circle'
                }}
              >
                <Tooltip permanent direction="center" className="radius-tooltip">
                  {formatRadius(draftRadius)}
                </Tooltip>
              </Circle>
            </>
          )}
          
          <MapController 
            target={alarms.length > 0 ? alarms[alarms.length - 1].targetLocation : null} 
            userLocation={userLocation}
            shouldFollowUser={shouldFollowUser}
            onMapMove={() => setShouldFollowUser(false)}
            onMapClick={(lat, lng) => {
              setDraftLocation([lat, lng]);
              setSelectedAlarmId(null);
            }}
            draftLocation={draftLocation}
            draftRadius={draftRadius}
          />
        </MapContainer>
      </div>

      {/* UI Overlay */}
      <div className="absolute inset-0 z-[1100] pointer-events-none flex flex-col items-center p-4">
        
        {/* Compact Header Bar */}
        <motion.header 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-lg bg-[#151619]/80 backdrop-blur-xl border border-white/10 rounded-full px-5 py-2.5 shadow-2xl pointer-events-auto flex items-center justify-between"
        >
          <div className="flex items-center gap-2.5">
            <div className="bg-orange-500/20 p-1.5 rounded-lg">
              <MapPin className="w-4 h-4 text-orange-500" />
            </div>
            <h1 className="text-white font-bold text-sm tracking-tight">GeoAlarm AI</h1>
          </div>

          <div className="flex items-center gap-3">
            {userLocation && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-blue-500/10 rounded-full border border-blue-500/20">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500"></span>
                </span>
                <span className="text-blue-400 text-[9px] font-black uppercase tracking-widest">Live</span>
              </div>
            )}
            <button
              onClick={() => setShouldFollowUser(true)}
              className={`p-1.5 rounded-lg transition-all flex items-center justify-center ${
                shouldFollowUser 
                ? 'bg-blue-500 text-white' 
                : 'text-white/40 hover:text-white'
              }`}
            >
              {geoLoading && !userLocation ? (
                <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
              ) : (
                <Crosshair className="w-4 h-4" />
              )}
            </button>
          </div>
        </motion.header>

        {/* Alarm Triggered Modal */}
        <AnimatePresence>
          {alarmTriggered && (
            <motion.div 
              id="alarm-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 flex flex-col items-center justify-center bg-red-600 pointer-events-auto z-[3000]"
            >
              <motion.div
                animate={{ 
                  backgroundColor: ['rgba(220, 38, 38, 1)', 'rgba(153, 27, 27, 1)', 'rgba(220, 38, 38, 1)'],
                }}
                transition={{ repeat: Infinity, duration: 0.5 }}
                className="absolute inset-0 z-0"
              />
              
              <motion.div 
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.8, opacity: 0 }}
                className="relative z-10 flex flex-col items-center px-6 text-center"
              >
                <motion.div 
                  animate={{ scale: [1, 1.2, 1] }}
                  transition={{ repeat: Infinity, duration: 1 }}
                  className="w-32 h-32 bg-white/20 rounded-full flex items-center justify-center mb-10 shadow-2xl"
                >
                  <Bell className="w-16 h-16 text-white" />
                </motion.div>
                
                <h2 className="text-5xl font-black text-white mb-4 tracking-tighter uppercase italic">ALARM!</h2>
                <p className="text-white text-2xl font-bold mb-12 leading-tight max-w-xs">
                  You are near <br/>
                  <span className="text-yellow-300 underline underline-offset-8">
                    {alarms.find(a => a.id === activeAlarmId)?.targetName}
                  </span>
                </p>
                
                <button
                  onClick={handleStopAlarm}
                  className="w-64 bg-white text-red-600 font-black py-8 rounded-full transition-all shadow-[0_20px_50px_rgba(0,0,0,0.3)] hover:scale-105 active:scale-95 flex items-center justify-center gap-4 text-2xl uppercase tracking-widest"
                >
                  <VolumeX className="w-8 h-8" />
                  STOP
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Bottom Section */}
        <div className="mt-auto w-full max-w-2xl flex flex-col gap-4 pointer-events-auto items-center">
          
          {/* Manual Pin Popup */}
          <AnimatePresence>
            {draftLocation && (
            <motion.div
                initial={{ y: 100, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 100, opacity: 0 }}
                className="w-[92%] max-w-sm p-4 shadow-2xl z-[1200] mb-2"
                style={{ 
                  background: 'rgba(10, 10, 10, 0.35)',
                  backdropFilter: 'blur(40px)',
                  WebkitBackdropFilter: 'blur(40px)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '1.5rem'
                }}
              >
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-bold">Set alarm here?</h3>
                  <button onClick={() => setDraftLocation(null)} className="p-1.5 text-white/40 hover:text-white">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex justify-between text-[10px] font-bold uppercase tracking-wider text-white/40">
                      <div className="flex items-center gap-1.5">
                        <Sliders className="w-3 h-3" />
                        Radius
                      </div>
                      <span>{formatRadius(draftRadius)}</span>
                    </div>
                    <input 
                      type="range" 
                      min="100" 
                      max="50000" 
                      step="100"
                      value={draftRadius}
                      onChange={(e) => setDraftRadius(parseInt(e.target.value))}
                      className="w-full h-1 bg-white/5 rounded-lg appearance-none cursor-pointer accent-orange-500"
                    />
                  </div>

                  <button
                    onClick={handleConfirmDraft}
                    disabled={isProcessing}
                    className="w-full bg-orange-500 hover:bg-orange-600 text-white font-black py-3 rounded-xl transition-all shadow-lg shadow-orange-500/20 flex items-center justify-center gap-2 text-xs"
                  >
                    {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Confirm Location
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Collapsible Bottom Sheet */}
          <AnimatePresence>
            {activeAlarms.length > 0 && (
              <motion.div
                initial={{ y: 100, opacity: 0 }}
                animate={{ y: isSheetExpanded ? 0 : 60, opacity: 1 }}
                exit={{ y: 100, opacity: 0 }}
                className="shadow-[0_-20px_50px_rgba(0,0,0,0.5)] overflow-hidden"
                style={{ 
                  background: 'rgba(10, 10, 10, 0.2)',
                  backdropFilter: 'blur(30px)',
                  WebkitBackdropFilter: 'blur(30px)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '2.5rem 2.5rem 0 0'
                }}
              >
                <button 
                  onClick={() => setIsSheetExpanded(!isSheetExpanded)}
                  className="w-full py-4 flex flex-col items-center gap-2 group"
                >
                  <div className="w-12 h-1.5 bg-white/10 rounded-full group-hover:bg-white/20 transition-colors"></div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30">Active Alarms</span>
                    <span className="bg-orange-500/20 text-orange-500 text-[10px] font-black px-2 py-0.5 rounded-md">{activeAlarms.length}</span>
                  </div>
                </button>

                <motion.div 
                  animate={{ height: isSheetExpanded ? 'auto' : 0 }}
                  className="px-6 pb-8 overflow-hidden"
                >
                  <div className="space-y-3 max-h-64 overflow-y-auto pr-2 custom-scrollbar">
                    {activeAlarms.map(alarm => (
                      <div key={alarm.id} className="flex items-center justify-between bg-white/5 rounded-3xl p-5 border border-white/5 hover:bg-white/10 transition-all group">
                        <div className="flex items-center gap-5">
                          <div className="w-12 h-12 bg-orange-500/10 rounded-2xl flex items-center justify-center">
                            <Navigation className="w-6 h-6 text-orange-500" />
                          </div>
                          <div>
                            <p className="font-bold text-base text-white">{alarm.targetName}</p>
                            <p className="text-white/40 text-xs font-medium">{formatRadius(alarm.radiusMeters)} radius</p>
                          </div>
                        </div>
                        <button 
                          onClick={() => removeAlarm(alarm.id)}
                          className="p-3 text-white/20 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Search Bar - Full Width */}
          <div className="w-full px-2 pb-4 relative">
            <form onSubmit={handleSubmit} className="relative group w-full">
              <AnimatePresence>
                {searchError && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="absolute -top-14 left-4 right-4 bg-red-500/90 backdrop-blur-md text-white text-xs font-bold py-3 px-5 rounded-2xl text-center border border-red-400/30 shadow-xl z-50"
                  >
                    {searchError}
                  </motion.div>
                )}
              </AnimatePresence>
              
              <div className="absolute inset-0 bg-gradient-to-r from-orange-500/20 to-blue-500/20 rounded-[2.5rem] blur-3xl opacity-30 group-hover:opacity-60 transition-opacity duration-700"></div>
              
              <div 
                className="relative shadow-2xl flex items-center p-1.5"
                style={{ 
                  background: 'rgba(10, 10, 10, 0.2)',
                  backdropFilter: 'blur(30px)',
                  WebkitBackdropFilter: 'blur(30px)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '2rem'
                }}
              >
                <div className="pl-4 pr-2">
                  <Search className="w-4 h-4 text-white/20" />
                </div>
                <input
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                  placeholder="e.g. Wake me up 2km before my office"
                  className="flex-1 bg-transparent border-none outline-none text-white placeholder:text-white/20 text-sm py-2.5 px-1 font-medium min-w-0"
                  disabled={isProcessing}
                />
                <div className="flex items-center gap-1 pr-1">
                  {inputText && (
                    <button 
                      type="button"
                      onClick={() => {
                        setInputText('');
                        setSuggestions([]);
                        setShowSuggestions(false);
                      }}
                      className="p-2 text-white/20 hover:text-white transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                  
                  <button 
                    type="button"
                    onClick={toggleRecording}
                    className={`p-2 rounded-full transition-all relative ${isRecording ? 'text-red-500' : 'text-white/20 hover:text-white'}`}
                  >
                    {isRecording && (
                      <motion.div
                        layoutId="mic-pulse"
                        className="absolute inset-0 bg-red-500/20 rounded-full"
                        animate={{ scale: [1, 1.5, 1] }}
                        transition={{ repeat: Infinity, duration: 1.5 }}
                      />
                    )}
                    <Mic className={`w-4 h-4 relative z-10 ${isRecording ? 'animate-pulse' : ''}`} />
                  </button>

                  <button 
                    type="submit"
                    disabled={isProcessing || !inputText.trim()}
                    className="bg-orange-500 hover:bg-orange-600 text-white text-[10px] font-black uppercase tracking-wider px-4 py-2 rounded-full transition-all disabled:opacity-50 disabled:hover:bg-orange-500 flex items-center gap-1.5"
                  >
                    {isProcessing ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <>
                        Set
                        <Check className="w-3 h-3" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>

            {/* Autocomplete Suggestions */}
            <AnimatePresence>
              {showSuggestions && suggestions.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="absolute bottom-full mb-4 left-4 right-4 bg-[#151619]/90 backdrop-blur-2xl border border-white/10 rounded-3xl overflow-hidden shadow-2xl z-[1300]"
                >
                  {suggestions.map((suggestion, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleSelectSuggestion(suggestion)}
                      className="w-full px-6 py-4 text-left text-white/70 hover:text-white hover:bg-white/5 transition-colors border-b border-white/5 last:border-none flex items-center gap-3"
                    >
                      <MapPin className="w-4 h-4 text-orange-500/50" />
                      <span className="truncate text-sm">{suggestion.display_name}</span>
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        
      </div>

      <style>{`
        .radius-tooltip {
          background: rgba(249, 115, 22, 0.9) !important;
          border: none !important;
          border-radius: 8px !important;
          color: white !important;
          font-weight: 800 !important;
          font-size: 12px !important;
          padding: 4px 8px !important;
          box-shadow: 0 4px 12px rgba(249, 115, 22, 0.3) !important;
        }
        .radius-tooltip::before {
          display: none !important;
        }
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>
    </div>
  );
}
