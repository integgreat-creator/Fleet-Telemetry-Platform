import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:vehicle_telemetry/config/app_colors.dart';
import 'package:vehicle_telemetry/providers/vehicle_provider.dart';

// ── Service label map ─────────────────────────────────────────────────────────

const _serviceLabels = <String, String>{
  'oil_change':       'Oil Change',
  'tire_rotation':    'Tyre Rotation',
  'air_filter':       'Air Filter',
  'brake_inspection': 'Brake Inspection',
  'engine_check':     'Engine Check',
};

String _labelFor(String type) =>
    _serviceLabels[type] ?? type.replaceAll('_', ' ').toUpperCase()[0] +
        type.replaceAll('_', ' ').substring(1);

// ── Status colours ────────────────────────────────────────────────────────────

Color _statusColor(String status) {
  switch (status) {
    case 'overdue':   return Colors.red.shade400;
    case 'due':       return Colors.amber.shade400;
    case 'completed': return Colors.green.shade400;
    default:          return Colors.blue.shade400;
  }
}

String _statusLabel(String status) {
  switch (status) {
    case 'overdue':   return 'Overdue';
    case 'due':       return 'Due Soon';
    case 'completed': return 'Done';
    default:          return 'Upcoming';
  }
}

// ── Main screen ───────────────────────────────────────────────────────────────

class MaintenanceScreen extends StatefulWidget {
  const MaintenanceScreen({super.key});

  @override
  State<MaintenanceScreen> createState() => _MaintenanceScreenState();
}

class _MaintenanceScreenState extends State<MaintenanceScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  List<Map<String, dynamic>> _predictions = [];
  List<Map<String, dynamic>> _logs        = [];
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _fetchData();
  }

  Future<void> _fetchData() async {
    final vehicleId =
        context.read<VehicleProvider>().selectedVehicle?.id;
    if (vehicleId == null) return;

    setState(() {
      _loading = true;
      _error   = null;
    });

    try {
      final client = Supabase.instance.client;

      final predsRes = await client
          .from('maintenance_predictions')
          .select()
          .eq('vehicle_id', vehicleId)
          .neq('status', 'completed')
          .order('status',    ascending: false)
          .order('due_date',  ascending: true)
          .limit(50);

      final logsRes = await client
          .from('maintenance_logs')
          .select()
          .eq('vehicle_id', vehicleId)
          .order('service_date', ascending: false)
          .limit(30);

      if (mounted) {
        setState(() {
          _predictions = List<Map<String, dynamic>>.from(predsRes as List);
          _logs        = List<Map<String, dynamic>>.from(logsRes  as List);
          _loading     = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error   = e.toString();
          _loading = false;
        });
      }
    }
  }

  // ── Mark-as-Serviced bottom sheet ─────────────────────────────────────────

  Future<void> _showMarkServicedSheet(Map<String, dynamic> pred) async {
    final vehicle = context.read<VehicleProvider>().selectedVehicle;
    if (vehicle == null) return;

    final client = Supabase.instance.client;

    // Get fleet_id for this vehicle
    final vehicleRow = await client
        .from('vehicles')
        .select('fleet_id')
        .eq('id', vehicle.id)
        .maybeSingle();
    final fleetId = vehicleRow?['fleet_id'] as String?;
    if (fleetId == null || !mounted) return;

    final dateCtrl  = TextEditingController(
        text: DateTime.now().toIso8601String().substring(0, 10));
    final kmCtrl    = TextEditingController();
    final costCtrl  = TextEditingController();
    final notesCtrl = TextEditingController();

    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.bgSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(ctx).viewInsets.bottom,
          left: 16, right: 16, top: 24,
        ),
        child: _MarkServicedForm(
          predictionId: pred['id'] as String,
          serviceType:  pred['prediction_type'] as String,
          vehicleId:    vehicle.id,
          fleetId:      fleetId,
          dateCtrl:     dateCtrl,
          kmCtrl:       kmCtrl,
          costCtrl:     costCtrl,
          notesCtrl:    notesCtrl,
          onSaved: () {
            Navigator.pop(ctx);
            _fetchData();
          },
        ),
      ),
    );
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgBase,
      appBar: AppBar(
        backgroundColor: AppColors.bgSurface,
        title: const Text(
          'Maintenance',
          style: TextStyle(
            color: Colors.white,
            fontWeight: FontWeight.bold,
            fontSize: 20,
          ),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded, color: Colors.white70),
            onPressed: _fetchData,
          ),
        ],
        bottom: TabBar(
          controller: _tabController,
          labelColor: AppColors.accentBlue,
          unselectedLabelColor: AppColors.textLabel,
          indicatorColor: AppColors.accentBlue,
          tabs: const [
            Tab(text: 'Service Schedule'),
            Tab(text: 'History'),
          ],
        ),
      ),
      body: Consumer<VehicleProvider>(
        builder: (context, vp, _) {
          if (vp.selectedVehicle == null) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(32),
                child: Text(
                  'Connect your OBD device or select a vehicle to view maintenance.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white54),
                ),
              ),
            );
          }

          if (_loading) {
            return const Center(
              child: CircularProgressIndicator(color: Colors.blue),
            );
          }

          if (_error != null) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(_error!, style: const TextStyle(color: Colors.red)),
                  const SizedBox(height: 12),
                  ElevatedButton(onPressed: _fetchData, child: const Text('Retry')),
                ],
              ),
            );
          }

          return TabBarView(
            controller: _tabController,
            children: [
              _buildPredictionsTab(),
              _buildHistoryTab(),
            ],
          );
        },
      ),
    );
  }

  // ── Predictions tab ───────────────────────────────────────────────────────

  Widget _buildPredictionsTab() {
    if (_predictions.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.build_outlined, size: 48, color: Colors.white24),
              const SizedBox(height: 12),
              const Text(
                'No active service predictions',
                style: TextStyle(color: Colors.white70, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 4),
              const Text(
                'Predictions are generated automatically.\nTap ↻ to refresh.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white38, fontSize: 13),
              ),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchData,
      color: AppColors.accentBlue,
      child: ListView.separated(
        padding: const EdgeInsets.all(16),
        itemCount: _predictions.length,
        separatorBuilder: (_, __) => const SizedBox(height: 10),
        itemBuilder: (context, i) => _buildPredictionCard(_predictions[i]),
      ),
    );
  }

  Widget _buildPredictionCard(Map<String, dynamic> pred) {
    final status    = pred['status'] as String? ?? 'upcoming';
    final type      = pred['prediction_type'] as String? ?? '';
    final dueAtKm   = pred['due_at_km'];
    final dueDate   = pred['due_date'] as String?;
    final desc      = pred['description'] as String?;
    final statusClr = _statusColor(status);

    return Container(
      decoration: BoxDecoration(
        color: AppColors.bgSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border(
          left: BorderSide(color: statusClr, width: 3),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Title row
            Row(
              children: [
                Expanded(
                  child: Text(
                    _labelFor(type),
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 15,
                    ),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: statusClr.withOpacity(0.15),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: statusClr.withOpacity(0.4)),
                  ),
                  child: Text(
                    _statusLabel(status),
                    style: TextStyle(
                      color: statusClr,
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),

            if (desc != null && desc.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(desc, style: const TextStyle(color: Colors.white54, fontSize: 12)),
            ],

            const SizedBox(height: 10),

            // Due info
            Row(
              children: [
                if (dueAtKm != null) ...[
                  Icon(Icons.speed_rounded, size: 14, color: statusClr),
                  const SizedBox(width: 4),
                  Text(
                    'Due at ${(dueAtKm as num).toStringAsFixed(0)} km',
                    style: TextStyle(color: statusClr, fontSize: 13, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(width: 16),
                ],
                if (dueDate != null) ...[
                  Icon(Icons.calendar_today_rounded, size: 14, color: Colors.white38),
                  const SizedBox(width: 4),
                  Text(
                    dueDate,
                    style: const TextStyle(color: Colors.white54, fontSize: 12),
                  ),
                ],
              ],
            ),

            const SizedBox(height: 12),
            const Divider(color: Colors.white12, height: 1),
            const SizedBox(height: 10),

            // Action button
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: () => _showMarkServicedSheet(pred),
                icon: const Icon(Icons.check_circle_outline_rounded, size: 16),
                label: const Text('Mark as Serviced'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: Colors.green.shade400,
                  side: BorderSide(color: Colors.green.shade800),
                  backgroundColor: Colors.green.shade900.withOpacity(0.2),
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ── History tab ───────────────────────────────────────────────────────────

  Widget _buildHistoryTab() {
    if (_logs.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.history_rounded, size: 48, color: Colors.white24),
              const SizedBox(height: 12),
              const Text(
                'No service history yet',
                style: TextStyle(color: Colors.white70, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 4),
              const Text(
                'Mark a service as completed to begin\nbuilding your maintenance record.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white38, fontSize: 13),
              ),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchData,
      color: AppColors.accentBlue,
      child: ListView.separated(
        padding: const EdgeInsets.all(16),
        itemCount: _logs.length,
        separatorBuilder: (_, __) => const SizedBox(height: 8),
        itemBuilder: (context, i) => _buildLogCard(_logs[i]),
      ),
    );
  }

  Widget _buildLogCard(Map<String, dynamic> log) {
    final type       = log['service_type'] as String? ?? '';
    final date       = log['service_date'] as String? ?? '';
    final odometerKm = log['odometer_km'];
    final cost       = log['cost'];
    final notes      = log['notes'] as String?;

    return Container(
      decoration: BoxDecoration(
        color: AppColors.bgSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white10),
      ),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.check_circle_rounded, size: 16, color: Colors.green.shade400),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  _labelFor(type),
                  style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.bold,
                    fontSize: 14,
                  ),
                ),
              ),
              Text(
                date,
                style: const TextStyle(color: Colors.white54, fontSize: 12),
              ),
            ],
          ),
          if (odometerKm != null || cost != null) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                if (odometerKm != null) ...[
                  const Icon(Icons.speed_rounded, size: 13, color: Colors.white38),
                  const SizedBox(width: 4),
                  Text(
                    '${(odometerKm as num).toStringAsFixed(0)} km',
                    style: const TextStyle(color: Colors.white54, fontSize: 12),
                  ),
                  const SizedBox(width: 16),
                ],
                if (cost != null) ...[
                  const Icon(Icons.currency_rupee_rounded, size: 13, color: Colors.white38),
                  const SizedBox(width: 2),
                  Text(
                    (cost as num).toStringAsFixed(0),
                    style: const TextStyle(color: Colors.white54, fontSize: 12),
                  ),
                ],
              ],
            ),
          ],
          if (notes != null && notes.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              notes,
              style: const TextStyle(color: Colors.white38, fontSize: 12),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ],
      ),
    );
  }
}

// ── Mark-as-Serviced form widget ──────────────────────────────────────────────

class _MarkServicedForm extends StatefulWidget {
  final String predictionId;
  final String serviceType;
  final String vehicleId;
  final String fleetId;
  final TextEditingController dateCtrl;
  final TextEditingController kmCtrl;
  final TextEditingController costCtrl;
  final TextEditingController notesCtrl;
  final VoidCallback onSaved;

  const _MarkServicedForm({
    required this.predictionId,
    required this.serviceType,
    required this.vehicleId,
    required this.fleetId,
    required this.dateCtrl,
    required this.kmCtrl,
    required this.costCtrl,
    required this.notesCtrl,
    required this.onSaved,
  });

  @override
  State<_MarkServicedForm> createState() => _MarkServicedFormState();
}

class _MarkServicedFormState extends State<_MarkServicedForm> {
  bool _saving = false;
  String? _error;

  Future<void> _save() async {
    setState(() { _saving = true; _error = null; });
    try {
      final client = Supabase.instance.client;

      // 1. Insert maintenance log
      await client.from('maintenance_logs').insert({
        'vehicle_id':   widget.vehicleId,
        'fleet_id':     widget.fleetId,
        'service_type': widget.serviceType,
        'service_date': widget.dateCtrl.text,
        'odometer_km':  widget.kmCtrl.text.isNotEmpty
            ? double.tryParse(widget.kmCtrl.text) : null,
        'cost':         widget.costCtrl.text.isNotEmpty
            ? double.tryParse(widget.costCtrl.text) : null,
        'notes':        widget.notesCtrl.text.trim().isNotEmpty
            ? widget.notesCtrl.text.trim() : null,
      });

      // 2. Mark prediction as completed
      await client
          .from('maintenance_predictions')
          .update({'status': 'completed'})
          .eq('id', widget.predictionId);

      widget.onSaved();
    } catch (e) {
      setState(() {
        _error  = e.toString();
        _saving = false;
      });
    }
  }

  InputDecoration _inputDec(String label, {String? hint}) => InputDecoration(
    labelText:    label,
    hintText:     hint,
    labelStyle:   const TextStyle(color: Colors.white54),
    hintStyle:    const TextStyle(color: Colors.white24),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(8),
      borderSide: const BorderSide(color: Colors.white12),
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(8),
      borderSide: BorderSide(color: AppColors.accentBlue),
    ),
    filled:    true,
    fillColor: Colors.white.withOpacity(0.04),
  );

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Mark as Serviced — ${_labelFor(widget.serviceType)}',
          style: const TextStyle(
            color: Colors.white,
            fontWeight: FontWeight.bold,
            fontSize: 16,
          ),
        ),
        const SizedBox(height: 16),

        // Service date
        TextField(
          controller: widget.dateCtrl,
          style: const TextStyle(color: Colors.white),
          decoration: _inputDec('Service Date (YYYY-MM-DD)', hint: 'e.g. 2026-04-17'),
          keyboardType: TextInputType.datetime,
        ),
        const SizedBox(height: 12),

        // Odometer
        TextField(
          controller: widget.kmCtrl,
          style: const TextStyle(color: Colors.white),
          decoration: _inputDec('Odometer (km)', hint: 'e.g. 45000'),
          keyboardType: TextInputType.number,
        ),
        const SizedBox(height: 12),

        // Cost
        TextField(
          controller: widget.costCtrl,
          style: const TextStyle(color: Colors.white),
          decoration: _inputDec('Cost (₹)', hint: 'e.g. 1200'),
          keyboardType: TextInputType.number,
        ),
        const SizedBox(height: 12),

        // Notes
        TextField(
          controller: widget.notesCtrl,
          style: const TextStyle(color: Colors.white),
          decoration: _inputDec('Notes (optional)'),
          maxLines: 2,
        ),

        if (_error != null) ...[
          const SizedBox(height: 10),
          Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 13)),
        ],

        const SizedBox(height: 20),

        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: () => Navigator.pop(context),
                style: OutlinedButton.styleFrom(
                  foregroundColor: Colors.white54,
                  side: const BorderSide(color: Colors.white12),
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                ),
                child: const Text('Cancel'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: ElevatedButton.icon(
                onPressed: _saving ? null : _save,
                icon: _saving
                    ? const SizedBox(
                        width: 16, height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Icon(Icons.check_rounded, size: 18),
                label: Text(_saving ? 'Saving…' : 'Save Service'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.green.shade700,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
      ],
    );
  }
}
