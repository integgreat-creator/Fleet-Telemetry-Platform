import obd
import logging

class OBDReader:
    """
    OBDReader handles the connection to the ELM327 adapter and performs
    dynamic PID discovery to determine which sensors the vehicle supports.
    """
    def __init__(self, port=None):
        self.connection = None
        self.port = port
        self.supported_pids = []
        # High priority sensors are polled every 1 second
        self.high_priority_pids = [
            'RPM', 'SPEED', 'COOLANT_TEMP', 'ENGINE_LOAD', 'THROTTLE_POS'
        ]
        logging.basicConfig(level=logging.INFO)
        self.logger = logging.getLogger("OBDReader")

    def connect(self):
        """
        Establishes connection and discovers supported PIDs.
        Uses python-OBD's automatic port detection if no port is specified.
        """
        self.connection = obd.OBD(self.port)
        if self.connection.is_connected():
            self.logger.info(f"Connected to vehicle. Status: {self.connection.status()}")
            self._discover_pids()
            return True
        self.logger.error("Failed to connect to OBD-II adapter.")
        return False

    def _discover_pids(self):
        """
        STEP 1: PID DISCOVERY ENGINE
        Dynamically detects supported Mode 01 commands (Real-time data).
        """
        self.supported_pids = []
        commands = self.connection.supported_commands
        for cmd in commands:
            # Mode 1 is for Current Powertrain Diagnostic Data
            if cmd.mode == 1:
                self.supported_pids.append(cmd)
        self.logger.info(f"Discovered {len(self.supported_pids)} supported sensors.")

    def get_supported_sensor_names(self):
        """Returns a list of names for all detected sensors."""
        return [cmd.name for cmd in self.supported_pids]

    def read_sensors(self, priority_filter=None):
        """
        STEP 2: SENSOR STREAMING ENGINE
        Polls sensors and returns a dictionary of values.
        Handles unit conversion and null values gracefully.
        """
        if not self.connection or not self.connection.is_connected():
            return None

        sensor_data = {}
        for cmd in self.supported_pids:
            # If a filter is provided (e.g., for high priority), skip others
            if priority_filter and cmd.name not in priority_filter:
                continue

            response = self.connection.query(cmd)

            if not response.is_null():
                # Extract numeric value (magnitude) if the response has units
                if hasattr(response.value, 'magnitude'):
                    sensor_data[cmd.name.lower()] = response.value.magnitude
                else:
                    sensor_data[cmd.name.lower()] = response.value
            else:
                # STEP 7: ERROR HANDLING
                # Return null values instead of crashing if sensor fails to respond
                sensor_data[cmd.name.lower()] = None

        return sensor_data
