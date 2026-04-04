import time
import threading
from .obd_reader import OBDReader
from .database_service import DatabaseService
from .alert_engine import AlertEngine

class TelemetryService:
    """
    Main engine that orchestrates PID discovery, streaming, and data storage.
    Includes performance optimizations for polling frequencies.
    """
    def __init__(self, vehicle_id, supabase_config):
        self.vehicle_id = vehicle_id
        self.reader = OBDReader()
        self.db = DatabaseService(supabase_config)
        self.alert_engine = AlertEngine(vehicle_id, self.db)
        self.running = False
        self.last_low_priority_poll = 0

    def start(self):
        """Starts the telemetry engine in a separate thread."""
        if self.reader.connect():
            self.running = True
            # Load alert thresholds from DB
            self.alert_engine.load_thresholds()

            # Start the streaming loop in the background
            self.thread = threading.Thread(target=self._streaming_loop, daemon=True)
            self.thread.start()
            print(f"Telemetry engine started for vehicle: {self.vehicle_id}")
            return True
        return False

    def _streaming_loop(self):
        """
        STEP 6: PERFORMANCE OPTIMIZATION
        Continuous loop for polling sensors at different frequencies.
        """
        while self.running:
            try:
                current_time = time.time()
                metrics = {}

                # Poll High Priority Sensors (RPM, Speed, etc.) every 1 second
                high_priority_data = self.reader.read_sensors(self.reader.high_priority_pids)
                if high_priority_data:
                    metrics.update(high_priority_data)

                # Poll Low Priority Sensors (everything else) every 5 seconds
                if current_time - self.last_low_priority_poll >= 5:
                    all_pids = self.reader.get_supported_sensor_names()
                    low_priority_pids = [p for p in all_pids if p not in self.reader.high_priority_pids]

                    if low_priority_pids:
                        low_priority_data = self.reader.read_sensors(low_priority_pids)
                        if low_priority_data:
                            metrics.update(low_priority_data)

                    self.last_low_priority_poll = current_time

                if metrics:
                    # STEP 3: Store in dynamic database
                    self.db.save_telemetry(self.vehicle_id, metrics)

                    # STEP 5: Check for alerts
                    self.alert_engine.check_metrics(metrics)

            except Exception as e:
                print(f"Loop error: {e}")
                # Wait before retrying to avoid spamming errors
                time.sleep(2)

            # 1 second base interval for the main loop
            time.sleep(1)

    def stop(self):
        """Stops the telemetry engine."""
        self.running = False
        if hasattr(self, 'thread'):
            self.thread.join(timeout=2)
        print("Telemetry engine stopped.")
