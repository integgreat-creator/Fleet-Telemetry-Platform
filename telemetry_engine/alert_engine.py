class AlertEngine:
    """
    STEP 5: ALERT ENGINE UPGRADE
    Upgraded to allow threshold alerts for any dynamic metric.
    """
    def __init__(self, vehicle_id, db_service):
        self.vehicle_id = vehicle_id
        self.db = db_service
        self.thresholds = {}

    def load_thresholds(self):
        """Loads all thresholds for the vehicle into memory for fast lookup."""
        data = self.db.get_thresholds(self.vehicle_id)
        for t in data:
            # Map by sensor type for quick checking
            self.thresholds[t['sensor_type'].lower()] = t
        print(f"Loaded {len(self.thresholds)} thresholds for vehicle {self.vehicle_id}")

    def check_metrics(self, metrics):
        """
        Iterates through incoming metrics and compares them against
        stored thresholds.
        """
        for metric_name, value in metrics.items():
            if value is None:
                continue

            # Check if we have a threshold defined for this metric
            threshold = self.thresholds.get(metric_name)
            if threshold and threshold.get('alert_enabled'):
                max_val = threshold.get('max_value')
                min_val = threshold.get('min_value')

                alert_triggered = False
                severity = 'info'
                message = ""

                if max_val is not None and value > max_val:
                    alert_triggered = True
                    # If 20% over max, mark as critical
                    severity = 'critical' if value > max_val * 1.2 else 'warning'
                    message = f"{metric_name} exceeded maximum: {value} (max: {max_val})"

                elif min_val is not None and value < min_val:
                    alert_triggered = True
                    # If 20% under min, mark as critical
                    severity = 'critical' if value < min_val * 0.8 else 'warning'
                    message = f"{metric_name} below minimum: {value} (min: {min_val})"

                if alert_triggered:
                    self.trigger_alert(metric_name, value, severity, message, threshold.get('id'))

    def trigger_alert(self, metric, value, severity, message, threshold_id):
        """
        In a real-world scenario, this would push an alert record to the
        Supabase 'alerts' table.
        """
        print(f"[{severity.upper()}] {message}")
        # Implementation for saving to database:
        # self.db.save_alert(self.vehicle_id, metric, value, severity, message, threshold_id)
