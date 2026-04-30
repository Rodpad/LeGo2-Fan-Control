import { definePlugin, call } from "@decky/api";
import { PanelSection, PanelSectionRow, ToggleField, SliderField, Field, ButtonItem } from "@decky/ui";
import { useState, useEffect, useRef, FC } from "react";
import { QR_CODE_BASE64, LOGO_BASE64 } from "./assets";

const PLUGIN_VERSION = "0.260430"; // AUTO-INJECTED

const qrImageSrc = `data:image/png;base64,${QR_CODE_BASE64}`;
const logoImageSrc = `data:image/png;base64,${LOGO_BASE64}`;

interface CurvePoint {
  temp: number;
  rpm: number;
}

const DEFAULT_CURVE: CurvePoint[] = [
  { temp: 0, rpm: 1500 },
  { temp: 50, rpm: 1800 },
  { temp: 65, rpm: 2000 },
  { temp: 75, rpm: 2200 },
  { temp: 85, rpm: 2800 },
  { temp: 100, rpm: 3800 }
];

const apiCall = async (method: string, args: any = {}): Promise<any> => {
  try {
    const hasArgs = args && Object.keys(args).length > 0;
    const res: any = hasArgs ? await call(method, args) : await call(method);
    return res?.success ? res.result : (res || null);
  } catch (e) {
    console.error(`Plugin API Error [${method}]:`, e);
    return null;
  }
};

const InteractiveGraph: FC<{
  curvePoints: CurvePoint[];
  onUpdateNode: (idx: number, temp: number, rpm: number, isSlider?: boolean) => void;
  disabled: boolean;
  currentTemp: number;
  isStepped: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}> = ({ curvePoints, onUpdateNode, disabled, currentTemp, isStepped, onDragStart, onDragEnd }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);

  const getX = (temp: number) => `${temp}%`;
  const getY = (rpm: number) => `${100 - (rpm / 6000) * 100}%`;

  const handlePointerDown = (idx: number, e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    setDraggingIdx(idx);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (onDragStart) onDragStart();
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (disabled || draggingIdx === null || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    let x = e.clientX - rect.left;
    let y = e.clientY - rect.top;

    let temp = Math.round((x / rect.width) * 100);
    let rpm = Math.round((100 - (y / rect.height) * 100) / 100 * 6000);
    rpm = Math.round(rpm / 100) * 100;

    onUpdateNode(draggingIdx, temp, rpm, false);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (draggingIdx !== null) {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      setDraggingIdx(null);
      if (onDragEnd) onDragEnd();
    }
  };

  const generatePolylinePoints = () => {
    return curvePoints.map(p => `${p.temp},${100 - (p.rpm / 6000) * 100}`).join(' ');
  };

  const polylinePoints = generatePolylinePoints();

  let activeSteppedIdx = -1;
  if (isStepped && currentTemp >= 0 && draggingIdx === null && !disabled) {
    for (let i = curvePoints.length - 1; i >= 0; i--) {
      if (currentTemp >= curvePoints[i].temp) {
        activeSteppedIdx = i;
        break;
      }
    }
    if (activeSteppedIdx === -1 && curvePoints.length > 0) activeSteppedIdx = 0;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '220px', opacity: disabled ? 0.5 : 1 }}>
      <div style={{ display: 'flex', width: '100%', height: '200px' }}>
        <div style={{ width: '22px', position: 'relative' }}>
          {[1000, 2000, 3000, 4000, 5000].map(rpm => (
            <div key={rpm} style={{ position: 'absolute', right: '4px', top: getY(rpm), transform: 'translateY(-50%)', fontSize: '10px', color: '#888' }}>
              {rpm / 1000}k
            </div>
          ))}
        </div>

        <div 
          ref={containerRef}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
          style={{ 
            flex: 1, 
            position: 'relative', 
            backgroundColor: '#1a1a1a', 
            borderRadius: '6px',
            border: '1px solid #333',
            boxSizing: 'border-box',
            touchAction: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            outline: 'none'
          }}
        >
          <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', top: 0, left: 0 }}>
            {[20, 40, 60, 80].map(v => (
              <line key={`v${v}`} x1={`${v}%`} y1="0" x2={`${v}%`} y2="100%" stroke="#333" strokeWidth="0.5" />
            ))}
            {[1000, 2000, 3000, 4000, 5000].map(v => (
              <line key={`h${v}`} x1="0" y1={getY(v)} x2="100%" y2={getY(v)} stroke="#333" strokeWidth="0.5" />
            ))}
            
            {currentTemp >= 0 && currentTemp <= 100 && (
              <line 
                x1={`${currentTemp}%`} y1="0" 
                x2={`${currentTemp}%`} y2="100%" 
                stroke="#3E8DDD" strokeWidth="0.75" strokeDasharray="4 4" opacity="0.8" 
              />
            )}

            <polyline points={polylinePoints} fill="none" stroke="#3E8DDD" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </svg>

          {activeSteppedIdx !== -1 && curvePoints[activeSteppedIdx] && (
            <div
              style={{
                position: 'absolute',
                left: getX(curvePoints[activeSteppedIdx].temp),
                top: getY(curvePoints[activeSteppedIdx].rpm),
                width: '26px',
                height: '26px',
                marginLeft: '-13px',
                marginTop: '-13px',
                boxSizing: 'border-box',
                backgroundColor: 'rgba(62, 141, 221, 0.4)',
                borderRadius: '50%',
                pointerEvents: 'none',
                zIndex: 1
              }}
            />
          )}

          {curvePoints.map((pt, idx) => {
            const isActive = draggingIdx === idx;
            return (
              <div
                key={idx}
                onPointerDown={(e) => handlePointerDown(idx, e)}
                style={{
                  position: 'absolute',
                  left: getX(pt.temp),
                  top: getY(pt.rpm),
                  width: '15px',
                  height: '15px',
                  marginLeft: '-7.5px',
                  marginTop: '-7.5px',
                  boxSizing: 'border-box',
                  backgroundColor: isActive ? '#3E8DDD' : '#FFF',
                  border: '1px solid #000',
                  borderRadius: '50%',
                  cursor: disabled ? 'default' : 'pointer',
                  boxShadow: '0 0 2px rgba(0,0,0,0.5)',
                  transition: 'background-color 0.1s',
                  zIndex: 2
                }}
              />
            );
          })}

          {draggingIdx !== null && curvePoints[draggingIdx] && (
            <div style={{
              position: 'absolute',
              left: getX(curvePoints[draggingIdx].temp),
              top: getY(curvePoints[draggingIdx].rpm),
              transform: 'translate(-50%, -74px)',
              backgroundColor: 'rgba(0,0,0,0.9)',
              border: '1px solid #444',
              color: '#FFF',
              padding: '4px 8px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 'bold',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              zIndex: 20,
              boxShadow: '0 2px 4px rgba(0,0,0,0.5)'
            }}>
              {curvePoints[draggingIdx].temp}°C | {curvePoints[draggingIdx].rpm} RPM
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', width: '100%', height: '20px', marginTop: '4px' }}>
        <div style={{ width: '22px' }} />
        <div style={{ flex: 1, position: 'relative' }}>
          {[20, 40, 60, 80].map(t => (
            <div key={t} style={{ position: 'absolute', left: getX(t), top: '0', transform: 'translateX(-50%)', fontSize: '10px', color: '#888' }}>
              {t}°C
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const SliderEditor: FC<{
  curvePoints: CurvePoint[];
  onUpdateNode: (idx: number, temp: number, rpm: number, isSlider?: boolean) => void;
  disabled: boolean;
}> = ({ curvePoints, onUpdateNode, disabled }) => {
  const [selectedIdx, setSelectedIdx] = useState(0);

  if (!curvePoints || curvePoints.length !== 6) return null;

  const pt = curvePoints[selectedIdx];

  let minTemp = 0;
  let maxTemp = 100;
  if (selectedIdx > 0 && selectedIdx < 5) {
    minTemp = curvePoints[selectedIdx - 1].temp + 1;
    maxTemp = curvePoints[selectedIdx + 1].temp - 1;
  }
  if (minTemp > maxTemp) minTemp = maxTemp;

  return (
    <>
      <PanelSectionRow>
        <SliderField 
          disabled={disabled}
          label={`Edit Node: Point ${selectedIdx + 1} of 6`}
          value={selectedIdx + 1}
          min={1} max={6} step={1}
          onChange={(v) => setSelectedIdx(v - 1)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField 
          disabled={disabled || selectedIdx === 0 || selectedIdx === 5}
          label={`Temperature: ${pt.temp}°C`}
          value={pt.temp}
          min={0} max={100} step={1}
          onChange={(v) => onUpdateNode(selectedIdx, v, pt.rpm, true)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField 
          disabled={disabled}
          label={`Fan Speed: ${pt.rpm} RPM`}
          value={pt.rpm}
          min={0} max={5200} step={100}
          onChange={(v) => onUpdateNode(selectedIdx, pt.temp, v, true)}
        />
      </PanelSectionRow>
      <div style={{ height: '25px' }} />
    </>
  );
};

const Content: FC = () => {
  const [isCompatible, setIsCompatible] = useState<boolean | null>(null);
  const [curveEnabled, setCurveEnabled] = useState(true);
  const [manualEnabled, setManualEnabled] = useState(false);
  const [steppedCurve, setSteppedCurve] = useState(true);
  const [fanSmoothing, setFanSmoothing] = useState(true);
  const [powerSync, setPowerSync] = useState(true);
  const [stats, setStats] = useState({ temp: 0, rpm: 0, target: 0 });
  const [showSliders, setShowSliders] = useState(false);
  const [showDonate, setShowDonate] = useState(false);
  
  const currentPModeRef = useRef<number>(0);
  const topRef = useRef<HTMLDivElement>(null);
  
  const [curvePoints, setCurvePoints] = useState<CurvePoint[]>([]);
  const latestCurveRef = useRef<CurvePoint[]>([]);
  const pendingSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveCurveToBackend = () => {
    if (latestCurveRef.current.length !== 6) return;
    const newCurveDict: Record<number, number> = {};
    latestCurveRef.current.forEach(p => {
      newCurveDict[p.temp] = p.rpm;
    });
    apiCall("update_entire_curve", { curve: newCurveDict });
  };

  const refreshCurveFromState = async () => {
    const state = await apiCall("get_state");
    if (state && state.curve) {
      const loadedPoints: CurvePoint[] = [];
      Object.entries(state.curve).forEach(([k, v]) => {
        loadedPoints.push({ temp: parseInt(k), rpm: v as number });
      });
      loadedPoints.sort((a, b) => a.temp - b.temp);
      if (loadedPoints.length === 6) {
        setCurvePoints(loadedPoints);
        latestCurveRef.current = loadedPoints;
      }
    }
  };

  useEffect(() => {
    setTimeout(() => {
      if (topRef.current) {
        topRef.current.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    }, 50);

    const init = async () => {
      const state = await apiCall("get_state");
      if (state) {
        setIsCompatible(state.is_compatible ?? true);
        setCurveEnabled(state.curve_enabled ?? true);
        setManualEnabled(!!state.manual_enabled);
        setSteppedCurve(state.stepped_curve ?? true);
        setFanSmoothing(state.fan_smoothing ?? true);
        setPowerSync(state.power_sync ?? true);
      }
      await refreshCurveFromState();
    };
    init();

    const fetchAndSetStats = async () => {
      const data = await apiCall("get_stats");
      if (data && typeof data === 'object') {
        setStats({ 
          temp: data.temp ?? 0, 
          rpm: data.rpm ?? 0,
          target: data.target ?? 0
        });

        if (data.pm !== undefined && data.pm !== currentPModeRef.current) {
          currentPModeRef.current = data.pm;
          await refreshCurveFromState();
        }
      }
    };

    fetchAndSetStats();
    const ticker = setInterval(fetchAndSetStats, 3000);
    return () => clearInterval(ticker);
  }, []);

  const handleNodeUpdate = (idx: number, temp: number, rpm: number, isSlider = false) => {
    if (curvePoints.length !== 6) return;

    const pts = curvePoints.map(p => ({ ...p }));
    
    let safeTemp = Math.max(0, Math.min(100, temp));
    let safeRpm = Math.max(0, Math.min(5200, rpm));
    if (safeRpm > 0 && safeRpm < 1500) {
      safeRpm = safeRpm < 750 ? 0 : 1500;
    }

    pts[idx].temp = safeTemp;
    pts[idx].rpm = safeRpm;

    pts[0].temp = 0;
    pts[5].temp = 100;

    for (let i = 1; i <= 4; i++) {
      if (pts[i].temp <= pts[i - 1].temp) pts[i].temp = pts[i - 1].temp + 1;
    }
    for (let i = 4; i >= 1; i--) {
      if (pts[i].temp >= pts[i + 1].temp) pts[i].temp = pts[i + 1].temp - 1;
    }
    for (let i = 1; i <= 4; i++) {
      if (pts[i].temp <= pts[i - 1].temp) pts[i].temp = pts[i - 1].temp + 1;
    }

    for (let i = 1; i <= 5; i++) {
      if (pts[i].rpm < pts[i - 1].rpm) pts[i].rpm = pts[i - 1].rpm;
    }
    for (let i = 4; i >= 0; i--) {
      if (pts[i].rpm > pts[i + 1].rpm) pts[i].rpm = pts[i + 1].rpm;
    }

    setCurvePoints(pts);
    latestCurveRef.current = pts;

    if (isSlider) {
      if (pendingSaveRef.current) clearTimeout(pendingSaveRef.current);
      pendingSaveRef.current = setTimeout(() => {
        saveCurveToBackend();
      }, 500);
    }
  };

  const handleResetAllSettings = async () => {
    await apiCall("reset_all_settings");
    
    const state = await apiCall("get_state");
    if (state) {
      setCurveEnabled(state.curve_enabled ?? true);
      setManualEnabled(!!state.manual_enabled);
      setSteppedCurve(state.stepped_curve ?? true);
      setFanSmoothing(state.fan_smoothing ?? true);
      setPowerSync(state.power_sync ?? true);
      
      if (state.curve) {
        const loadedPoints: CurvePoint[] = [];
        Object.entries(state.curve).forEach(([k, v]) => {
          loadedPoints.push({ temp: parseInt(k), rpm: v as number });
        });
        loadedPoints.sort((a, b) => a.temp - b.temp);
        if (loadedPoints.length === 6) {
          setCurvePoints(loadedPoints);
        }
      }
    }
  };

  if (isCompatible === false) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div style={{ textAlign: 'center', padding: '20px 0', color: '#FFF' }}>
            <div style={{ marginBottom: '8px' }}>This plugin is only compatible with the Lenovo Legion Go 2.</div>
            <div style={{ fontSize: '12px', color: '#888' }}>(Model 8ASP2 and 8AHP2 not found)</div>
          </div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <>
      <div ref={topRef} />
      <PanelSection>
        <PanelSectionRow>
          <ToggleField 
            label={<span style={{ fontWeight: 'bold' }}>Enable LeGo2 Fan Control</span>}
            checked={curveEnabled} 
            onChange={(v) => { 
              setCurveEnabled(v); 
              if (v) setManualEnabled(false); 
              apiCall("set_curve_mode", { enabled: v }); 
            }} 
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection>
        <PanelSectionRow>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: '8px', opacity: curveEnabled ? 1 : 0.5, marginLeft: '-15px', marginRight: '10px' }}>
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', fontWeight: 'bold' }}>APU Temp</div>
              <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#FFF' }}>{stats.temp} °C</div>
            </div>
            <div style={{ width: '1px', backgroundColor: '#333', alignSelf: 'stretch', margin: '0 8px' }} />
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', fontWeight: 'bold' }}>Fan Speed</div>
              <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#FFF' }}>{stats.rpm} RPM</div>
            </div>
          </div>
        </PanelSectionRow>
      </PanelSection>

      <div style={{ marginTop: '-16px' }}>
        <PanelSection>
          {showSliders ? (
             <SliderEditor 
               curvePoints={curvePoints} 
               onUpdateNode={handleNodeUpdate} 
               disabled={!curveEnabled} 
             />
          ) : (
            <PanelSectionRow>
              <div style={{ marginLeft: '-23px', marginRight: '10px', marginTop: '10px', width: '100%' }}>
                <InteractiveGraph 
                  curvePoints={curvePoints} 
                  onUpdateNode={handleNodeUpdate} 
                  disabled={!curveEnabled} 
                  currentTemp={stats.temp}
                  isStepped={steppedCurve}
                  onDragStart={() => {}}
                  onDragEnd={() => saveCurveToBackend()}
                />
              </div>
            </PanelSectionRow>
          )}
        </PanelSection>
      </div>

      <div style={{ marginTop: '-16px' }}>
        <PanelSection>
          <PanelSectionRow>
            <ButtonItem 
              layout="below" 
              onClick={() => setShowDonate(!showDonate)}
            >
              {showDonate ? "Close" : "Donate and say thanks!"}
            </ButtonItem>
          </PanelSectionRow>
          
          {showDonate && (
            <PanelSectionRow>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 0' }}>
                <img 
                  src={qrImageSrc} 
                  alt="Donate QR Code" 
                  style={{ width: '200px', height: 'auto', borderRadius: '8px', marginBottom: '10px' }} 
                />
                <div style={{ fontSize: '0.85em', color: '#ccc', textAlign: 'center', marginBottom: '15px' }}>
                  Scan to donate via your phone, or use the button below to open PayPal in the browser.
                </div>
                <ButtonItem 
                  layout="below" 
                  onClick={() => window.open('https://www.paypal.com/donate/?hosted_button_id=WEYCJDNC5KCD4', '_blank')}
                >
                  Donate via PayPal
                </ButtonItem>
                <div style={{ fontSize: '0.75em', color: '#888', marginTop: '12px', textAlign: 'center' }}>
                  All donations are entirely optional, but greatly appreciated!
                </div>
              </div>
            </PanelSectionRow>
          )}
        </PanelSection>
      </div>

      <div style={{ marginTop: '-16px' }}>
        <PanelSection>
          <PanelSectionRow>
            <ToggleField
              disabled={!curveEnabled}
              label={
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span style={{ opacity: !showSliders ? 1 : 0.5, fontWeight: !showSliders ? 'bold' : 'normal' }}>Graph</span>
                  <span style={{ opacity: 0.3 }}>/</span>
                  <span style={{ opacity: showSliders ? 1 : 0.5, fontWeight: showSliders ? 'bold' : 'normal' }}>Sliders</span>
                </div>
              }
              checked={showSliders}
              onChange={(v) => setShowSliders(v)}
            />
          </PanelSectionRow>

          <PanelSectionRow>
            <ToggleField 
              disabled={!curveEnabled}
              label="Link to Power Modes" 
              description="Use different fan curves per power mode - Low Power, Balanced, Performance and Custom."
              checked={powerSync} 
              onChange={(v) => {
                setPowerSync(v);
                apiCall("set_power_sync", { enabled: v }).then(() => {
                  refreshCurveFromState();
                });
              }} 
            />
          </PanelSectionRow>
          
          <PanelSectionRow>
            <ToggleField 
              disabled={!curveEnabled}
              label="Fan Smoothing" 
              description="Ignores sudden temperature spikes while catching slow temperature rises."
              checked={fanSmoothing}
              onChange={(v) => {
                setFanSmoothing(v);
                apiCall("set_fan_smoothing", { enabled: v });
              }}
            />
          </PanelSectionRow>

          <PanelSectionRow>
            <ToggleField 
              disabled={!curveEnabled}
              label="Stepped Fan Curve" 
              description="Only use the exact speeds set at the 6 points in your fan curve."
              checked={steppedCurve}
              onChange={(v) => {
                setSteppedCurve(v);
                apiCall("set_stepped_curve", { enabled: v });
              }}
            />
          </PanelSectionRow>

          <PanelSectionRow>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '15px 0 5px 0' }}>
              <img 
                src={logoImageSrc} 
                alt="LeGo2 Fan Control Logo" 
                style={{ width: '64px', height: 'auto', marginBottom: '10px' }} 
              />
              <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#FFF' }}>LeGo2 Fan Control</div>
              <div style={{ fontSize: '12px', color: '#888', marginBottom: '12px' }}>v{PLUGIN_VERSION}</div>
              <div style={{ fontSize: '13px', color: '#ccc', textAlign: 'center', marginBottom: '6px' }}>
                Full unrestricted fan control for the<br />Legion Go 2.
              </div>
              <div style={{ fontSize: '11px', color: '#888', textAlign: 'center' }}>
                Created by Luke Cama
              </div>
            </div>
          </PanelSectionRow>

          <PanelSectionRow>
            <ButtonItem 
              layout="below" 
              onClick={handleResetAllSettings}
            >
              Reset All Settings
            </ButtonItem>
          </PanelSectionRow>

        </PanelSection>
      </div>
    </>
  );
};

export default definePlugin(() => ({
  name: "lego2-fan-control",
  title: <div className="title" style={{ color: '#66c0f4', fontWeight: 'bold' }}>LeGo2 Fan Control</div>,
  content: <Content />,
  icon: <span>🌀</span>,
}));