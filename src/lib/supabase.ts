import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface Fleet {
  id: string;
  name: string;
  organization: string;
  manager_id: string;
  created_at: string;
}

export interface Vehicle {
  id: string;
  name: string;
  vin: string;
  make: string;
  model: string;
  year: number;
  owner_id: string;
  fleet_id?: string;
  is_active: boolean;
  health_score: number;
  last_connected?: string;
  fuel_price_per_litre: number;
  avg_km_per_litre: number;
  maintenance_cost_per_km?: number;
  driver_phone?: string;
  driver_email?: string;
  fuel_type: string;
  battery_capacity_kwh?: number;
  cng_capacity_kg?: number;
  created_at: string;
  updated_at: string;
}

export interface SensorData {
  id: string;
  vehicle_id: string;
  sensor_type: string;
  value: number;
  unit: string;
  timestamp: string;
  created_at: string;
}

export interface Alert {
  id: string;
  vehicle_id: string;
  sensor_type: string;
  threshold_id?: string;
  value: number;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  acknowledged: boolean;
  acknowledged_at?: string;
  acknowledged_by?: string;
  created_at: string;
  vehicles?: {
    name: string;
    vin: string;
  };
}

export interface Threshold {
  id: string;
  vehicle_id: string;
  sensor_type: string;
  min_value?: number;
  max_value?: number;
  alert_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface DriverBehavior {
  id: string;
  vehicle_id: string;
  trip_id?: string;
  harsh_braking_count: number;
  harsh_acceleration_count: number;
  excessive_rpm_count: number;
  excessive_speed_count: number;
  average_engine_load: number;
  driver_score: number;
  trip_start: string;
  trip_end?: string;
  created_at: string;
}

export interface Trip {
  id: string;
  vehicle_id: string;
  driver_id?: string;
  start_time: string;
  end_time?: string;
  distance_km: number;
  duration_minutes: number;
  avg_speed_kmh: number;
  fuel_consumed_litres: number;
  idle_time_minutes: number;
  status: 'active' | 'completed';
  // Revenue / profit tracking (added by trip-profit-tracking migration)
  total_revenue?: number;
  total_expense?: number;
  profit?: number;
  // Telematics reliability (added by telematics_reliability migration)
  gap_count?: number;
  gap_duration_minutes?: number;
  data_confidence_score?: number;
}

export interface FuelEvent {
  id: string;
  vehicle_id: string;
  type: 'excessive_idle' | 'fuel_theft' | 'refuel';
  timestamp: string;
  value: number;
  message: string;
}

export interface CostInsight {
  id: string;
  vehicle_id: string;
  type: string;
  message: string;
  potential_savings: number;
  severity: 'info' | 'warning' | 'critical';
  is_resolved: boolean;
  created_at: string;
}

export interface CostPrediction {
  id: string;
  vehicle_id: string;
  forecast_period: 'monthly' | 'quarterly' | 'yearly';
  estimated_fuel_cost: number;
  estimated_maintenance_cost: number;
  estimated_insurance_cost: number;
  estimated_total_cost: number;
  confidence_score: number;
  factors: {
    driving_impact: string;
    historical_trend: string;
  };
  created_at: string;
}

export interface MaintenancePrediction {
  id: string;
  vehicle_id: string;
  prediction_type: string;
  description: string;
  due_at_km: number;
  due_date?: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  status: 'upcoming' | 'due' | 'overdue' | 'completed';
  created_at: string;
}
