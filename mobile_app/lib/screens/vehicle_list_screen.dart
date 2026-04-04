import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vehicle_telemetry/providers/vehicle_provider.dart';
import 'package:vehicle_telemetry/screens/vehicle_form_screen.dart';

class VehicleListScreen extends StatefulWidget {
  const VehicleListScreen({Key? key}) : super(key: key);

  @override
  State<VehicleListScreen> createState() => _VehicleListScreenState();
}

class _VehicleListScreenState extends State<VehicleListScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<VehicleProvider>().loadVehicles();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('My Vehicles'),
      ),
      body: Consumer<VehicleProvider>(
        builder: (context, vehicleProvider, _) {
          if (vehicleProvider.isLoading) {
            return const Center(child: CircularProgressIndicator());
          }

          if (vehicleProvider.vehicles.isEmpty) {
            return Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(
                    Icons.directions_car_outlined,
                    size: 64,
                    color: Colors.grey,
                  ),
                  const SizedBox(height: 16),
                  const Text('No vehicles added yet'),
                  const SizedBox(height: 16),
                  ElevatedButton.icon(
                    onPressed: () => _navigateToAddVehicle(context),
                    icon: const Icon(Icons.add),
                    label: const Text('Add Vehicle'),
                  ),
                ],
              ),
            );
          }

          return ListView.builder(
            itemCount: vehicleProvider.vehicles.length,
            itemBuilder: (context, index) {
              final vehicle = vehicleProvider.vehicles[index];
              final isSelected = vehicleProvider.selectedVehicle?.id == vehicle.id;

              return Card(
                margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                elevation: isSelected ? 4 : 1,
                color: isSelected ? Colors.blue.shade50 : Colors.white,
                child: ListTile(
                  leading: Icon(
                    Icons.directions_car,
                    color: isSelected ? Colors.blue : Colors.grey,
                    size: 40,
                  ),
                  title: Text(
                    vehicle.name,
                    style: TextStyle(
                      fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                    ),
                  ),
                  subtitle: Text(
                    [
                      if (vehicle.make != null) vehicle.make,
                      if (vehicle.model != null) vehicle.model,
                      if (vehicle.year != null) vehicle.year.toString(),
                    ].join(' '),
                  ),
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (isSelected)
                        const Icon(Icons.check_circle, color: Colors.blue),
                      PopupMenuButton(
                        itemBuilder: (context) => [
                          const PopupMenuItem(
                            value: 'edit',
                            child: Row(
                              children: [
                                Icon(Icons.edit),
                                SizedBox(width: 8),
                                Text('Edit'),
                              ],
                            ),
                          ),
                          const PopupMenuItem(
                            value: 'delete',
                            child: Row(
                              children: [
                                Icon(Icons.delete, color: Colors.red),
                                SizedBox(width: 8),
                                Text('Delete', style: TextStyle(color: Colors.red)),
                              ],
                            ),
                          ),
                        ],
                        onSelected: (value) {
                          if (value == 'edit') {
                            _navigateToEditVehicle(context, vehicle.id);
                          } else if (value == 'delete') {
                            _deleteVehicle(context, vehicle.id, vehicle.name);
                          }
                        },
                      ),
                    ],
                  ),
                  onTap: () {
                    vehicleProvider.selectVehicle(vehicle);
                    Navigator.of(context).pop();
                  },
                ),
              );
            },
          );
        },
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _navigateToAddVehicle(context),
        child: const Icon(Icons.add),
      ),
    );
  }

  void _navigateToAddVehicle(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => const VehicleFormScreen()),
    );
  }

  void _navigateToEditVehicle(BuildContext context, String vehicleId) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => VehicleFormScreen(vehicleId: vehicleId),
      ),
    );
  }

  void _deleteVehicle(BuildContext context, String vehicleId, String vehicleName) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete Vehicle'),
        content: Text('Are you sure you want to delete $vehicleName?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () {
              context.read<VehicleProvider>().deleteVehicle(vehicleId);
              Navigator.of(context).pop();
            },
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
  }
}
