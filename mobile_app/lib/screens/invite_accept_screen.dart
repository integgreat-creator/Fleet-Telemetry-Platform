import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:vehicle_telemetry/providers/invite_provider.dart';
import 'package:vehicle_telemetry/providers/vehicle_provider.dart';
import 'package:vehicle_telemetry/screens/home_screen.dart';

class InviteAcceptScreen extends StatefulWidget {
  final String token;
  const InviteAcceptScreen({Key? key, required this.token}) : super(key: key);

  @override
  State<InviteAcceptScreen> createState() => _InviteAcceptScreenState();
}

class _InviteAcceptScreenState extends State<InviteAcceptScreen> {
  // Invite details fetched from server
  String? _fleetName;
  String? _vehicleName;
  bool _loadingInvite = true;
  String? _loadError;

  // Form controllers
  final _formKey = GlobalKey<FormState>();
  final _vinController   = TextEditingController();
  final _makeController  = TextEditingController();
  final _modelController = TextEditingController();
  final _yearController  = TextEditingController(
    text: DateTime.now().year.toString(),
  );

  bool _submitting = false;
  String? _submitError;

  String get _supabaseUrl => dotenv.env['SUPABASE_URL'] ?? '';
  String get _anonKey     => dotenv.env['SUPABASE_ANON_KEY'] ?? '';

  @override
  void initState() {
    super.initState();
    _fetchInviteDetails();
  }

  @override
  void dispose() {
    _vinController.dispose();
    _makeController.dispose();
    _modelController.dispose();
    _yearController.dispose();
    super.dispose();
  }

  Future<void> _fetchInviteDetails() async {
    try {
      final uri = Uri.parse(
        '$_supabaseUrl/functions/v1/invite-api?action=get&token=${widget.token}',
      );
      final res = await http.get(uri, headers: {
        'apikey':        _anonKey,
        'Authorization': 'Bearer $_anonKey',
      });

      final body = jsonDecode(res.body) as Map<String, dynamic>;

      if (res.statusCode != 200) {
        setState(() {
          _loadError     = body['error'] as String? ?? 'Invalid or expired invite';
          _loadingInvite = false;
        });
        return;
      }

      setState(() {
        _fleetName     = body['fleet_name'] as String?;
        _vehicleName   = body['vehicle_name'] as String?;
        _loadingInvite = false;
      });
    } catch (e) {
      setState(() {
        _loadError     = 'Could not reach server. Check your internet connection.';
        _loadingInvite = false;
      });
    }
  }

  Future<void> _acceptInvite() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() { _submitting = true; _submitError = null; });

    try {
      final uri = Uri.parse('$_supabaseUrl/functions/v1/invite-api');
      final res = await http.post(
        uri,
        headers: {
          'Content-Type':  'application/json',
          'apikey':        _anonKey,
          'Authorization': 'Bearer $_anonKey',
        },
        body: jsonEncode({
          'action': 'accept',
          'token':  widget.token,
          'vin':    _vinController.text.trim().toUpperCase(),
          'make':   _makeController.text.trim(),
          'model':  _modelController.text.trim(),
          'year':   int.parse(_yearController.text.trim()),
        }),
      );

      final body = jsonDecode(res.body) as Map<String, dynamic>;

      if (res.statusCode != 200) {
        setState(() {
          _submitError = body['error'] as String? ?? 'Failed to join fleet';
          _submitting  = false;
        });
        return;
      }

      final vehicleId = body['vehicle_id'] as String;
      final fleetId   = body['fleet_id']   as String;

      // Persist vehicle + fleet selections
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('vehicle_id', vehicleId);
      await prefs.setString('fleet_id',   fleetId);

      // Load vehicles in provider and select this one
      if (mounted) {
        final vehicleProvider = context.read<VehicleProvider>();
        await vehicleProvider.loadVehicles();
        await vehicleProvider.selectVehicleById(vehicleId);

        // Clear the pending token
        context.read<InviteProvider>().clearToken();

        // Navigate to HomeScreen
        Navigator.of(context).pushAndRemoveUntil(
          MaterialPageRoute(builder: (_) => const HomeScreen()),
          (route) => false,
        );
      }
    } catch (e) {
      setState(() {
        _submitError = 'Unexpected error: $e';
        _submitting  = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Join Fleet'),
        leading: BackButton(
          onPressed: () {
            context.read<InviteProvider>().clearToken();
            Navigator.of(context).pop();
          },
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: _loadingInvite
              ? const Center(child: CircularProgressIndicator())
              : _loadError != null
                  ? _buildError()
                  : _buildForm(),
        ),
      ),
    );
  }

  Widget _buildError() {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        const SizedBox(height: 48),
        const Icon(Icons.error_outline, size: 64, color: Colors.red),
        const SizedBox(height: 16),
        Text(
          _loadError!,
          style: const TextStyle(color: Colors.red),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 24),
        ElevatedButton(
          onPressed: () {
            context.read<InviteProvider>().clearToken();
            Navigator.of(context).pop();
          },
          child: const Text('Go Back'),
        ),
      ],
    );
  }

  Widget _buildForm() {
    return Form(
      key: _formKey,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Invite info banner
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Colors.blue.withOpacity(0.1),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Colors.blue.withOpacity(0.3)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  "You've been invited to join a fleet",
                  style: TextStyle(
                    color: Colors.blue,
                    fontWeight: FontWeight.bold,
                    fontSize: 16,
                  ),
                ),
                const SizedBox(height: 8),
                _infoRow('Fleet',   _fleetName   ?? '—'),
                _infoRow('Vehicle', _vehicleName ?? '—'),
              ],
            ),
          ),
          const SizedBox(height: 24),

          const Text(
            'Enter your vehicle details',
            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
          ),
          const SizedBox(height: 4),
          Text(
            'These details will be stored and visible to the fleet manager.',
            style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
          ),
          const SizedBox(height: 20),

          // VIN
          TextFormField(
            controller: _vinController,
            decoration: const InputDecoration(
              labelText: 'VIN *',
              hintText:  'e.g. 1HGBH41JXMN109186',
              prefixIcon: Icon(Icons.confirmation_number),
            ),
            textCapitalization: TextCapitalization.characters,
            validator: (v) {
              if (v == null || v.trim().isEmpty) return 'VIN is required';
              if (v.trim().length < 11) return 'VIN must be at least 11 characters';
              return null;
            },
          ),
          const SizedBox(height: 16),

          // Make
          TextFormField(
            controller: _makeController,
            decoration: const InputDecoration(
              labelText:  'Make *',
              hintText:   'e.g. Toyota',
              prefixIcon: Icon(Icons.directions_car),
            ),
            validator: (v) =>
                v == null || v.trim().isEmpty ? 'Make is required' : null,
          ),
          const SizedBox(height: 16),

          // Model
          TextFormField(
            controller: _modelController,
            decoration: const InputDecoration(
              labelText:  'Model *',
              hintText:   'e.g. Hilux',
              prefixIcon: Icon(Icons.car_rental),
            ),
            validator: (v) =>
                v == null || v.trim().isEmpty ? 'Model is required' : null,
          ),
          const SizedBox(height: 16),

          // Year
          TextFormField(
            controller: _yearController,
            decoration: const InputDecoration(
              labelText:  'Year *',
              hintText:   '2020',
              prefixIcon: Icon(Icons.calendar_today),
            ),
            keyboardType: TextInputType.number,
            validator: (v) {
              if (v == null || v.trim().isEmpty) return 'Year is required';
              final y = int.tryParse(v.trim());
              if (y == null || y < 1980 || y > DateTime.now().year + 1) {
                return 'Enter a valid year';
              }
              return null;
            },
          ),
          const SizedBox(height: 24),

          if (_submitError != null) ...[
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.red.withOpacity(0.1),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.red.withOpacity(0.3)),
              ),
              child: Text(
                _submitError!,
                style: const TextStyle(color: Colors.red, fontSize: 13),
              ),
            ),
            const SizedBox(height: 16),
          ],

          ElevatedButton(
            onPressed: _submitting ? null : _acceptInvite,
            style: ElevatedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 16),
            ),
            child: _submitting
                ? const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text(
                    'Accept & Join Fleet',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _infoRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        children: [
          Text('$label: ',
              style: const TextStyle(color: Colors.blue, fontSize: 13)),
          Text(value,
              style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w600,
                  fontSize: 13)),
        ],
      ),
    );
  }
}
