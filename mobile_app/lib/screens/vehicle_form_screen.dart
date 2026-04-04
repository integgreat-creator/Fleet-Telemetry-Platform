import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:uuid/uuid.dart';
import 'package:vehicle_telemetry/models/vehicle.dart';
import 'package:vehicle_telemetry/providers/vehicle_provider.dart';
import 'package:vehicle_telemetry/providers/auth_provider.dart';

class VehicleFormScreen extends StatefulWidget {
  final String? vehicleId;

  const VehicleFormScreen({Key? key, this.vehicleId}) : super(key: key);

  @override
  State<VehicleFormScreen> createState() => _VehicleFormScreenState();
}

class _VehicleFormScreenState extends State<VehicleFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _vinController = TextEditingController();
  final _makeController = TextEditingController();
  final _modelController = TextEditingController();
  final _yearController = TextEditingController();

  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    if (widget.vehicleId != null) {
      _loadVehicle();
    }
  }

  void _loadVehicle() {
    final vehicleProvider = context.read<VehicleProvider>();
    final vehicle = vehicleProvider.vehicles.firstWhere(
      (v) => v.id == widget.vehicleId,
    );

    _nameController.text = vehicle.name;
    _vinController.text = vehicle.vin ?? '';
    _makeController.text = vehicle.make ?? '';
    _modelController.text = vehicle.model ?? '';
    _yearController.text = vehicle.year?.toString() ?? '';
  }

  @override
  void dispose() {
    _nameController.dispose();
    _vinController.dispose();
    _makeController.dispose();
    _modelController.dispose();
    _yearController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _isLoading = true;
    });

    final vehicleProvider = context.read<VehicleProvider>();
    final authProvider = context.read<AuthProvider>();
    final userId = authProvider.user!.id;

    final vehicle = Vehicle(
      id: widget.vehicleId ?? const Uuid().v4(),
      name: _nameController.text,
      vin: _vinController.text.isEmpty ? null : _vinController.text,
      make: _makeController.text.isEmpty ? null : _makeController.text,
      model: _modelController.text.isEmpty ? null : _modelController.text,
      year: _yearController.text.isEmpty ? null : int.tryParse(_yearController.text),
      userId: userId,
      createdAt: DateTime.now(),
    );

    final success = widget.vehicleId == null
        ? await vehicleProvider.createVehicle(vehicle)
        : await vehicleProvider.updateVehicle(vehicle);

    setState(() {
      _isLoading = false;
    });

    if (mounted) {
      if (success) {
        Navigator.of(context).pop();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Failed to save vehicle'),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.vehicleId == null ? 'Add Vehicle' : 'Edit Vehicle'),
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            TextFormField(
              controller: _nameController,
              decoration: const InputDecoration(
                labelText: 'Vehicle Name',
                border: OutlineInputBorder(),
                prefixIcon: Icon(Icons.label),
              ),
              validator: (value) {
                if (value == null || value.isEmpty) {
                  return 'Please enter a vehicle name';
                }
                return null;
              },
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _vinController,
              decoration: const InputDecoration(
                labelText: 'VIN (Optional)',
                border: OutlineInputBorder(),
                prefixIcon: Icon(Icons.confirmation_number),
              ),
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _makeController,
              decoration: const InputDecoration(
                labelText: 'Make (Optional)',
                border: OutlineInputBorder(),
                prefixIcon: Icon(Icons.business),
              ),
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _modelController,
              decoration: const InputDecoration(
                labelText: 'Model (Optional)',
                border: OutlineInputBorder(),
                prefixIcon: Icon(Icons.directions_car),
              ),
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _yearController,
              decoration: const InputDecoration(
                labelText: 'Year (Optional)',
                border: OutlineInputBorder(),
                prefixIcon: Icon(Icons.calendar_today),
              ),
              keyboardType: TextInputType.number,
            ),
            const SizedBox(height: 24),
            ElevatedButton(
              onPressed: _isLoading ? null : _submit,
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
              child: _isLoading
                  ? const CircularProgressIndicator()
                  : Text(widget.vehicleId == null ? 'Add Vehicle' : 'Update Vehicle'),
            ),
          ],
        ),
      ),
    );
  }
}
