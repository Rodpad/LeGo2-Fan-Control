import os
import time
import json
import threading
import logging
from logging.handlers import RotatingFileHandler
import decky_plugin
from typing import Optional

# Logging Setup: Single recycled file (1MB limit), Errors Only
log_dir = "/home/deck/homebrew/logs/lego2-fan-control"
os.makedirs(log_dir, exist_ok=True)
log_path = os.path.join(log_dir, "fan_control.log")

fan_logger = logging.getLogger("FanControl")
fan_logger.setLevel(logging.ERROR)
handler = RotatingFileHandler(log_path, maxBytes=1_000_000, backupCount=1)
handler.setFormatter(logging.Formatter('[%(asctime)s][%(levelname)s]: %(message)s'))
fan_logger.addHandler(handler)

logger = decky_plugin.logger

class FanManager:
    """
    Core hardware controller for the Legion Go 2.
    Handles I/O, thermal monitoring, and settings persistence.
    """
    REG_RPM_READ = 0xC6C0
    REG_FACTORY_TARGET = 0xC6C2
    REG_OVERRIDE_WRITE = 0xC6C8
    REG_POWER_MODE = 0xC683
    SETTINGS_PATH = os.path.join(decky_plugin.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")

    # Unified Default Curve (6-point spread)
    DEF_CURVE = {0: 1500, 50: 1800, 65: 2000, 75: 2200, 85: 2800, 100: 3800}
    
    # Custom Power Mode Default Curve
    DEF_CUSTOM_CURVE = {0: 1500, 50: 1800, 65: 2000, 75: 2200, 80: 2800, 100: 3800}

    # State Variables
    is_compatible = True
    curve_enabled = True
    manual_enabled = False
    manual_rpm = 3000
    stepped_curve = True
    fan_smoothing = True
    power_sync = True
    last_p_mode = 0
    force_next_update = False
    
    manual_profile = DEF_CURVE.copy()
    power_profiles = {
        176: DEF_CURVE.copy(), # Performance
        177: DEF_CURVE.copy(), # Balanced
        178: DEF_CURVE.copy(), # Quiet
        179: DEF_CUSTOM_CURVE.copy()  # Custom
    }
    curve = DEF_CURVE.copy()
    
    # Cached Variables for Optimization
    _cached_sorted_temps = sorted(DEF_CURVE.keys())
    
    # Monitor Data
    current_temp = 0
    current_rpm = 0
    current_target = 0

    # Smoothing State
    last_applied_temp = -1
    last_eval_tick = 0
    last_mode = "Factory"
    
    # Hardware specific optimizations
    _last_written_target = -1
    _tick_count = 0
    
    _thread: Optional[threading.Thread] = None
    _running = False
    _port_fd: Optional[int] = None
    _sensor_path: Optional[str] = None
    
    # Pre-allocated bytes for speed
    B_2E = b'\x2E'
    B_11 = b'\x11'
    B_2F = b'\x2F'
    B_10 = b'\x10'
    B_12 = b'\x12'

    @classmethod
    def check_compatibility(cls):
        """Checks sysfs DMI data for Legion Go 2 model strings."""
        dmi_paths = [
            "/sys/class/dmi/id/product_version",
            "/sys/class/dmi/id/product_name",
            "/sys/class/dmi/id/product_family",
            "/sys/class/dmi/id/board_name",
            "/sys/class/dmi/id/board_version"
        ]
        
        dmi_data = ""
        for path in dmi_paths:
            try:
                if os.path.exists(path):
                    with open(path, "r") as f:
                        dmi_data += f.read().strip().upper() + " "
            except Exception:
                pass
                
        if "8ASP2" in dmi_data or "8AHP2" in dmi_data:
            cls.is_compatible = True
        else:
            cls.is_compatible = False
            logger.error(f"FanManager: Incompatible hardware detected. Plugin disabled. DMI strings: {dmi_data.strip()}")

    @classmethod
    def load_settings(cls):
        """Loads user settings from the Decky settings directory."""
        try:
            if os.path.exists(cls.SETTINGS_PATH):
                with open(cls.SETTINGS_PATH, "r") as f:
                    data = json.load(f)
                    cls.curve_enabled = data.get("curve_enabled", True)
                    cls.manual_enabled = data.get("manual_enabled", False)
                    cls.manual_rpm = data.get("manual_rpm", 3000)
                    cls.stepped_curve = data.get("stepped_curve", True)
                    cls.power_sync = data.get("power_sync", True)
                    
                    if "fan_smoothing" in data:
                        cls.fan_smoothing = data.get("fan_smoothing", True)
                    elif "smoothing_ticks" in data: # Legacy migration
                        cls.fan_smoothing = data.get("smoothing_ticks", 0) > 0
                    
                    if "manual_profile" in data:
                        saved_man = data["manual_profile"]
                        if len(saved_man) == 6:
                            cls.manual_profile = {int(k): int(v) for k, v in saved_man.items()}
                            
                    if "power_profiles" in data:
                        for k, v in data["power_profiles"].items():
                            mode_key = int(k)
                            if mode_key in cls.power_profiles and len(v) == 6:
                                cls.power_profiles[mode_key] = {int(tk): int(tv) for tk, tv in v.items()}
            
            # The active curve will be selected naturally during the first loop iteration based on actual EC power state
            cls.curve = cls.manual_profile.copy()
            cls._cached_sorted_temps = sorted(cls.curve.keys())
            
        except Exception as e:
            logger.error(f"FanManager: Failed to load settings: {e}")

    @classmethod
    def save_settings(cls):
        """Saves current state to ensure persistence across reboots and sleep."""
        try:
            os.makedirs(os.path.dirname(cls.SETTINGS_PATH), exist_ok=True)
            payload = {
                "curve_enabled": cls.curve_enabled,
                "manual_enabled": cls.manual_enabled,
                "manual_rpm": cls.manual_rpm,
                "stepped_curve": cls.stepped_curve,
                "fan_smoothing": cls.fan_smoothing,
                "power_sync": cls.power_sync,
                "manual_profile": cls.manual_profile,
                "power_profiles": cls.power_profiles
            }
            with open(cls.SETTINGS_PATH, "w") as f:
                json.dump(payload, f)
        except Exception as e:
            logger.error(f"FanManager: Failed to save settings: {e}")

    @classmethod
    def save_active_curve(cls):
        """Pushes the currently active UI curve into the correct storage dictionary."""
        if cls.power_sync and cls.last_p_mode in cls.power_profiles:
            cls.power_profiles[cls.last_p_mode] = cls.curve.copy()
        else:
            cls.manual_profile = cls.curve.copy()

    @classmethod
    def load_active_curve(cls):
        """Pulls the correct curve from storage dictionaries to serve as the active UI curve."""
        if cls.power_sync and cls.last_p_mode in cls.power_profiles:
            cls.curve = cls.power_profiles[cls.last_p_mode].copy()
        else:
            cls.curve = cls.manual_profile.copy()
        cls._cached_sorted_temps = sorted(cls.curve.keys())

    @classmethod
    def ec_io(cls, addr: int, data: Optional[int] = None) -> int:
        if cls._port_fd is None: return 0
        fd = cls._port_fd
        
        try:
            # Use os.pwrite and os.pread to merge seek+read/write into single syscalls
            os.pwrite(fd, cls.B_2E, 0x4E)
            os.pwrite(fd, cls.B_11, 0x4F)
            os.pwrite(fd, cls.B_2F, 0x4E)
            os.pwrite(fd, bytes([(addr >> 8) & 0xFF]), 0x4F)
            
            os.pwrite(fd, cls.B_2E, 0x4E)
            os.pwrite(fd, cls.B_10, 0x4F)
            os.pwrite(fd, cls.B_2F, 0x4E)
            os.pwrite(fd, bytes([addr & 0xFF]), 0x4F)
            
            os.pwrite(fd, cls.B_2E, 0x4E)
            os.pwrite(fd, cls.B_12, 0x4F)
            os.pwrite(fd, cls.B_2F, 0x4E)
            
            if data is not None:
                os.pwrite(fd, bytes([data & 0xFF]), 0x4F)
                return 0
            return os.pread(fd, 1, 0x4F)[0]
        except Exception as e:
            logger.error(f"EC Failure: {e}")
            return 0

    @classmethod
    def find_sensor(cls):
        for i in range(20):
            path = f"/sys/class/hwmon/hwmon{i}"
            if not os.path.exists(path): continue
            try:
                with open(f"{path}/name", "r") as f:
                    if f.read().strip() in ["k10temp", "amdgpu", "zenpower"]:
                        cls._sensor_path = f"{path}/temp1_input"
                        return
            except: continue
        cls._sensor_path = "/sys/class/thermal/thermal_zone0/temp"

    @classmethod
    def _loop(cls):
        try:
            cls._port_fd = os.open('/dev/port', os.O_RDWR)
        except Exception as e:
            logger.error(f"Hardware Error: Could not open /dev/port: {e}")
            return

        try:
            while cls._running:
                cls._tick_count += 1
                
                if cls._sensor_path:
                    try:
                        with open(cls._sensor_path, "r") as f:
                            cls.current_temp = int(f.read().strip()) // 1000
                    except Exception as e: 
                        logger.error(f"Sensor Read Error: {e}")

                try:
                    low_rpm = cls.ec_io(cls.REG_RPM_READ)
                    high_rpm = cls.ec_io(cls.REG_RPM_READ + 1)
                    cls.current_rpm = (high_rpm << 8) | low_rpm

                    p_mode = cls.ec_io(cls.REG_POWER_MODE)
                    
                    if cls.last_p_mode == 0:
                        cls.last_p_mode = p_mode
                        cls.load_active_curve()
                    elif cls.power_sync and p_mode != cls.last_p_mode and p_mode in cls.power_profiles:
                        cls.save_active_curve()
                        cls.last_p_mode = p_mode
                        cls.load_active_curve()
                        cls.last_mode = "CurveSwapped"
                    else:
                        cls.last_p_mode = p_mode

                    mode_str = "Factory"
                    override_target = 0

                    if cls.manual_enabled:
                        override_target = cls.manual_rpm
                        mode_str = "Fixed"
                    elif cls.curve_enabled:
                        mode_str = "Curve"
                        ideal_target = -1
                        is_panic = False
                        
                        sorted_temps = cls._cached_sorted_temps
                        
                        if cls.current_temp >= 101:
                            max_t = sorted_temps[-1] if sorted_temps else 100
                            max_rpm = cls.curve.get(max_t, 3800)
                            ideal_target = max(3800, max_rpm)
                            is_panic = True
                        elif cls.stepped_curve:
                            for t in reversed(sorted_temps):
                                if cls.current_temp >= t:
                                    ideal_target = cls.curve[t]
                                    break
                            if ideal_target == -1 and sorted_temps:
                                ideal_target = cls.curve[sorted_temps[0]]
                        else:
                            if not sorted_temps:
                                ideal_target = 0
                            elif cls.current_temp <= sorted_temps[0]:
                                ideal_target = cls.curve[sorted_temps[0]]
                            elif cls.current_temp >= sorted_temps[-1]:
                                ideal_target = cls.curve[sorted_temps[-1]]
                            else:
                                for i in range(len(sorted_temps) - 1):
                                    t1, t2 = sorted_temps[i], sorted_temps[i+1]
                                    if t1 <= cls.current_temp <= t2:
                                        rpm1, rpm2 = cls.curve[t1], cls.curve[t2]
                                        fraction = (cls.current_temp - t1) / (t2 - t1)
                                        ideal_target = int(round(rpm1 + fraction * (rpm2 - rpm1)))
                                        break
                        
                        if ideal_target != -1:
                            if cls.last_mode != "Curve" or is_panic:
                                override_target = ideal_target
                                cls.last_applied_temp = cls.current_temp
                                cls.last_eval_tick = cls._tick_count
                                if not is_panic:
                                    cls.force_next_update = False
                            else:
                                if cls.force_next_update:
                                    override_target = ideal_target
                                    cls.last_applied_temp = cls.current_temp
                                    cls.last_eval_tick = cls._tick_count
                                    cls.force_next_update = False
                                elif cls.fan_smoothing:
                                    # Evaluates every 6 seconds (2 ticks * 3 seconds)
                                    if (cls._tick_count - cls.last_eval_tick) >= 2: 
                                        cls.last_eval_tick = cls._tick_count
                                        
                                        if ideal_target != cls.current_target:
                                            # Anchor Algorithm: Check if temp has moved >= 5 degrees since the LAST time we applied an update
                                            if abs(cls.current_temp - cls.last_applied_temp) >= 5:
                                                override_target = ideal_target
                                                cls.last_applied_temp = cls.current_temp
                                            else:
                                                override_target = cls.current_target
                                        else:
                                            override_target = cls.current_target
                                    else:
                                        override_target = cls.current_target
                                else:
                                    override_target = ideal_target
                                    cls.last_applied_temp = cls.current_temp
                    
                    cls.last_mode = mode_str
                    
                    # Rewrite safety to assert dominance over BIOS resets
                    force_write = (cls._tick_count % 10 == 0)

                    if mode_str == "Factory":
                        f_low = cls.ec_io(cls.REG_FACTORY_TARGET)
                        f_high = cls.ec_io(cls.REG_FACTORY_TARGET + 1)
                        cls.current_target = (f_high << 8) | f_low
                        
                        if cls._last_written_target != 0 or force_write:
                            cls.ec_io(cls.REG_OVERRIDE_WRITE, 0)
                            cls.ec_io(cls.REG_OVERRIDE_WRITE + 1, 0)
                            cls._last_written_target = 0
                    else:
                        cls.current_target = override_target
                        actual_write = 1 if override_target == 0 else override_target
                        
                        if actual_write != cls._last_written_target or force_write:
                            cls.ec_io(cls.REG_OVERRIDE_WRITE, actual_write & 0xFF)
                            cls.ec_io(cls.REG_OVERRIDE_WRITE + 1, (actual_write >> 8) & 0xFF)
                            cls._last_written_target = actual_write

                except Exception as e:
                    fan_logger.error(f"Manager Loop Error: {e}")
                
                time.sleep(3)

        finally:
            # THIS IS THE FOOLPROOF SAFETY CATCH
            # Ensures control is explicitly released back to the EC regardless of how the script ends
            cls.ec_io(cls.REG_OVERRIDE_WRITE, 0)
            cls.ec_io(cls.REG_OVERRIDE_WRITE + 1, 0)
            if cls._port_fd: os.close(cls._port_fd)

class Plugin:
    async def get_state(self, *args, **kwargs):
        return {
            "is_compatible": FanManager.is_compatible,
            "curve_enabled": FanManager.curve_enabled,
            "manual_enabled": FanManager.manual_enabled,
            "manual_rpm": FanManager.manual_rpm,
            "stepped_curve": FanManager.stepped_curve,
            "fan_smoothing": FanManager.fan_smoothing,
            "power_sync": FanManager.power_sync,
            "curve": {str(k): v for k, v in FanManager.curve.items()}
        }

    async def get_stats(self, *args, **kwargs):
        return {
            "temp": int(FanManager.current_temp),
            "rpm": int(FanManager.current_rpm),
            "target": int(FanManager.current_target),
            "pm": int(FanManager.last_p_mode)
        }

    async def set_manual_mode(self, data: dict = {}, *args, **kwargs):
        FanManager.manual_enabled = bool(data.get("enabled", False))
        if FanManager.manual_enabled: FanManager.curve_enabled = False
        FanManager.manual_rpm = int(data.get("rpm", 3000))
        FanManager.save_settings()
        return True

    async def set_curve_mode(self, data: dict = {}, *args, **kwargs):
        FanManager.curve_enabled = bool(data.get("enabled", False))
        if FanManager.curve_enabled: FanManager.manual_enabled = False
        FanManager.save_settings()
        return True

    async def set_power_sync(self, data: dict = {}, *args, **kwargs):
        new_sync = bool(data.get("enabled", False))
        if new_sync != FanManager.power_sync:
            FanManager.save_active_curve()
            FanManager.power_sync = new_sync
            FanManager.load_active_curve()
            FanManager.save_settings()
        return True

    async def set_stepped_curve(self, data: dict = {}, *args, **kwargs):
        FanManager.stepped_curve = bool(data.get("enabled", False))
        FanManager.save_settings()
        return True

    async def set_fan_smoothing(self, data: dict = {}, *args, **kwargs):
        FanManager.fan_smoothing = bool(data.get("enabled", True))
        FanManager.save_settings()
        return True

    async def update_entire_curve(self, data: dict = {}, *args, **kwargs):
        new_curve = data.get("curve", {})
        parsed_curve = {}
        for k, v in new_curve.items():
            parsed_curve[int(k)] = int(v)
        FanManager.curve = parsed_curve
        FanManager._cached_sorted_temps = sorted(FanManager.curve.keys())
        FanManager.save_active_curve()
        FanManager.save_settings()
        FanManager.force_next_update = True
        return True

    async def reset_all_settings(self, *args, **kwargs):
        FanManager.curve_enabled = True
        FanManager.manual_enabled = False
        FanManager.manual_rpm = 3000
        FanManager.stepped_curve = True
        FanManager.fan_smoothing = True
        FanManager.power_sync = True
        
        FanManager.manual_profile = FanManager.DEF_CURVE.copy()
        FanManager.power_profiles = {
            176: FanManager.DEF_CURVE.copy(),
            177: FanManager.DEF_CURVE.copy(),
            178: FanManager.DEF_CURVE.copy(),
            179: FanManager.DEF_CUSTOM_CURVE.copy()
        }
            
        FanManager.load_active_curve()
        FanManager.save_settings()
        FanManager.force_next_update = True
        return True

    async def _main(self):
        FanManager.check_compatibility()
        if FanManager.is_compatible:
            FanManager.load_settings()
            FanManager.find_sensor()
            FanManager._running = True
            FanManager._thread = threading.Thread(target=FanManager._loop, daemon=True)
            FanManager._thread.start()

    async def _unload(self):
        FanManager._running = False
        if FanManager._thread:
            FanManager._thread.join()