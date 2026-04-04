import { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { supabase, type Vehicle } from '../lib/supabase';
import VehicleCard from '../components/VehicleCard';

interface VehiclesPageProps {
  onSelectVehicle: (vehicle: Vehicle) => void;
}

export default function VehiclesPage({ onSelectVehicle }: VehiclesPageProps) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [fleetId, setFleetId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    vin: '',
    make: '',
    model: '',
    year: new Date().getFullYear(),
    driver_phone: '',
    driver_email: '',
    fuel_type: 'petrol',
  });

  useEffect(() => {
    loadFleetAndVehicles();
  }, []);

  const loadFleetAndVehicles = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // 1. Get user's fleet
      const { data: fleetData, error: fleetError } = await supabase
        .from('fleets')
        .select('id')
        .eq('manager_id', user.id)
        .single();

      if (fleetError) throw fleetError;
      setFleetId(fleetData.id);

      // 2. Get vehicles for this fleet
      const { data, error } = await supabase
        .from('vehicles')
        .select('*')
        .eq('fleet_id', fleetData.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      if (data) setVehicles(data);
    } catch (error) {
      console.error('Error loading vehicles:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddVehicle = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !fleetId) return;

      // 1. Insert vehicle
      const { data: vehicleData, error } = await supabase.from('vehicles').insert({
        ...formData,
        owner_id: user.id,
        fleet_id: fleetId,
      }).select().single();

      if (error) throw error;

      // 2. Record invitation / Send Mock SMS
      if (formData.driver_phone) {
        await supabase.from('invitations').insert({
          vehicle_id: vehicleData.id,
          phone: formData.driver_phone,
          fleet_id: fleetId
        });

        // Mock SMS Sending
        console.log(`SMS Sent to ${formData.driver_phone}: Download VehicleSense App. Your Fleet ID: ${fleetId}`);
        alert(`SMS Invitation sent to ${formData.driver_phone}\nApp Link: https://vehiclesense.app/download?fleetId=${fleetId}`);
      }

      setShowAddForm(false);
      setFormData({
        name: '',
        vin: '',
        make: '',
        model: '',
        year: new Date().getFullYear(),
        driver_phone: '',
        driver_email: '',
        fuel_type: 'petrol',
      });
      loadFleetAndVehicles();
    } catch (error) {
      console.error('Error adding vehicle:', error);
      alert('Failed to add vehicle');
    }
  };

  const handleDeleteVehicle = async (id: string) => {
    if (!confirm('Are you sure you want to delete this vehicle? This action cannot be undone.')) {
      return;
    }

    try {
      const { error } = await supabase
        .from('vehicles')
        .delete()
        .eq('id', id);

      if (error) throw error;

      setVehicles(vehicles.filter(v => v.id !== id));
    } catch (error) {
      console.error('Error deleting vehicle:', error);
      alert('Failed to delete vehicle');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Vehicles</h1>
          <p className="text-gray-400">Manage and monitor your fleet vehicles</p>
        </div>
        <button
          onClick={() => setShowAddForm(true)}
          className="flex items-center space-x-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white transition-colors"
        >
          <Plus className="w-5 h-5" />
          <span>Add Vehicle</span>
        </button>
      </div>

      {showAddForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 rounded-lg p-6 max-w-md w-full border border-gray-800 overflow-y-auto max-h-[90vh]">
            <h2 className="text-xl font-bold text-white mb-4">Add New Vehicle</h2>
            <form onSubmit={handleAddVehicle} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">Vehicle Name</label>
                <input
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                  placeholder="e.g., Fleet Vehicle 001"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">VIN</label>
                <input
                  type="text"
                  required
                  value={formData.vin}
                  onChange={(e) => setFormData({ ...formData, vin: e.target.value })}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                  placeholder="Vehicle Identification Number"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Make</label>
                  <input
                    type="text"
                    required
                    value={formData.make}
                    onChange={(e) => setFormData({ ...formData, make: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                    placeholder="e.g., Ford"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Model</label>
                  <input
                    type="text"
                    required
                    value={formData.model}
                    onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                    placeholder="e.g., F-150"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Year</label>
                  <input
                    type="number"
                    required
                    min="1900"
                    max={new Date().getFullYear() + 1}
                    value={formData.year}
                    onChange={(e) => setFormData({ ...formData, year: parseInt(e.target.value) })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Fuel Type</label>
                  <select
                    value={formData.fuel_type}
                    onChange={(e) => setFormData({ ...formData, fuel_type: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                  >
                    <option value="petrol">Petrol</option>
                    <option value="diesel">Diesel</option>
                    <option value="cng">CNG</option>
                    <option value="ev">EV</option>
                  </select>
                </div>
              </div>

              <div className="border-t border-gray-800 pt-4 mt-4">
                <h3 className="text-sm font-bold text-gray-300 mb-3 uppercase tracking-wider">Driver Assignment</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">Phone Number (For App Invite)</label>
                    <input
                      type="tel"
                      required
                      value={formData.driver_phone}
                      onChange={(e) => setFormData({ ...formData, driver_phone: e.target.value })}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                      placeholder="+1 234 567 8900"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">Email (Optional)</label>
                    <input
                      type="email"
                      value={formData.driver_email}
                      onChange={(e) => setFormData({ ...formData, driver_email: e.target.value })}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                      placeholder="driver@example.com"
                    />
                  </div>
                </div>
              </div>

              <div className="flex space-x-3 pt-4">
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white transition-colors"
                >
                  Add & Invite
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="flex-1 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-white transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {vehicles.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-400 mb-4">No vehicles added yet</p>
          <button
            onClick={() => setShowAddForm(true)}
            className="inline-flex items-center space-x-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg text-white transition-colors"
          >
            <Plus className="w-5 h-5" />
            <span>Add Your First Vehicle</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {vehicles.map((vehicle) => (
            <VehicleCard
              key={vehicle.id}
              vehicle={vehicle}
              onClick={() => onSelectVehicle(vehicle)}
              onDelete={() => handleDeleteVehicle(vehicle.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
