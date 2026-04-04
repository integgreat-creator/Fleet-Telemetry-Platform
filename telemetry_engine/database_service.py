import requests
import datetime
import json

class DatabaseService:
    """
    Handles communication with the Supabase backend.
    Supports storing dynamic metrics as JSON objects.
    """
    def __init__(self, config):
        self.url = config['url']
        self.key = config['key']
        self.headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
        }

    def save_telemetry(self, vehicle_id, metrics):
        """
        STEP 3: DATABASE STORAGE
        Stores dynamic metrics as a JSON object in the sensor_data table.
        """
        # Ensure timestamp is ISO format
        timestamp = datetime.datetime.utcnow().isoformat() + 'Z'

        payload = {
            "vehicle_id": vehicle_id,
            "timestamp": timestamp,
            "metrics": metrics,
            "sensor_type": "dynamic_batch", # Compatibility field
            "value": 0,                     # Compatibility field
            "unit": "batch"                 # Compatibility field
        }

        try:
            # Endpoint for the Supabase REST API (PostgREST)
            response = requests.post(
                f"{self.url}/rest/v1/sensor_data",
                data=json.dumps(payload),
                headers=self.headers
            )
            response.raise_for_status()
        except Exception as e:
            print(f"Error saving telemetry: {e}")

    def get_thresholds(self, vehicle_id):
        """Retrieves alert thresholds for a specific vehicle."""
        try:
            response = requests.get(
                f"{self.url}/rest/v1/thresholds?vehicle_id=eq.{vehicle_id}",
                headers=self.headers
            )
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"Error fetching thresholds: {e}")
            return []
