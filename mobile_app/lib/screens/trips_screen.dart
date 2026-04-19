import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:vehicle_telemetry/config/app_colors.dart';
import 'package:vehicle_telemetry/screens/trip_detail_screen.dart';

class TripsScreen extends StatefulWidget {
  const TripsScreen({Key? key}) : super(key: key);

  @override
  State<TripsScreen> createState() => _TripsScreenState();
}

class _TripsScreenState extends State<TripsScreen> {
  final _supabase = Supabase.instance.client;
  List<Map<String, dynamic>> _trips = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadTrips();
  }

  Future<void> _loadTrips() async {
    setState(() { _loading = true; _error = null; });
    try {
      final res = await _supabase
          .from('trips')
          .select('*, vehicles(name), total_revenue, total_expense, profit')
          .order('start_time', ascending: false)
          .limit(100);
      if (mounted) {
        setState(() {
          _trips = List<Map<String, dynamic>>.from(res as List);
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) setState(() { _error = e.toString(); _loading = false; });
    }
  }

  String _fmtDate(String? iso) {
    if (iso == null) return '—';
    final d = DateTime.tryParse(iso)?.toLocal();
    if (d == null) return '—';
    return '${d.day.toString().padLeft(2, '0')} '
        '${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.month - 1]} '
        '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  String _rupee(dynamic n) {
    final v = double.tryParse(n?.toString() ?? '0') ?? 0;
    if (v == 0) return '—';
    return '₹${v.abs().toStringAsFixed(0)}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgPrimary,
      appBar: AppBar(
        backgroundColor: AppColors.bgSurface,
        elevation: 0,
        title: const Text('Trips', style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w700)),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded, color: AppColors.textSecondary),
            onPressed: _loadTrips,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.accentBlue))
          : _error != null
              ? _buildError()
              : _trips.isEmpty
                  ? _buildEmpty()
                  : RefreshIndicator(
                      onRefresh: _loadTrips,
                      color: AppColors.accentBlue,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _trips.length,
                        itemBuilder: (_, i) => _TripCard(
                          trip: _trips[i],
                          fmtDate: _fmtDate,
                          rupee: _rupee,
                          onTap: () async {
                            await Navigator.push(context,
                              MaterialPageRoute(
                                builder: (_) => TripDetailScreen(trip: _trips[i]),
                              ),
                            );
                            _loadTrips();
                          },
                        ),
                      ),
                    ),
    );
  }

  Widget _buildError() => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.error_outline, color: AppColors.statusError, size: 48),
          const SizedBox(height: 12),
          Text(_error!, style: const TextStyle(color: AppColors.textSecondary), textAlign: TextAlign.center),
          const SizedBox(height: 16),
          ElevatedButton(onPressed: _loadTrips, child: const Text('Retry')),
        ],
      ),
    ),
  );

  Widget _buildEmpty() => const Center(
    child: Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Icon(Icons.route_outlined, size: 64, color: AppColors.textLabel),
        SizedBox(height: 12),
        Text('No trips yet', style: TextStyle(color: AppColors.textSecondary, fontSize: 16)),
        SizedBox(height: 6),
        Text('Trips are recorded automatically when driving', style: TextStyle(color: AppColors.textLabel, fontSize: 13)),
      ],
    ),
  );
}

// ── Trip Card ─────────────────────────────────────────────────────────────────

class _TripCard extends StatelessWidget {
  final Map<String, dynamic> trip;
  final String Function(String?) fmtDate;
  final String Function(dynamic) rupee;
  final VoidCallback onTap;

  const _TripCard({
    required this.trip,
    required this.fmtDate,
    required this.rupee,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final vehicleName = (trip['vehicles'] as Map?)?['name'] as String? ?? '—';
    final status      = trip['status'] as String? ?? '';
    final distKm      = double.tryParse(trip['distance_km']?.toString() ?? '0') ?? 0;
    final profit      = double.tryParse(trip['profit']?.toString() ?? '0') ?? 0;
    final revenue     = double.tryParse(trip['total_revenue']?.toString() ?? '0') ?? 0;
    final expense     = double.tryParse(trip['total_expense']?.toString() ?? '0') ?? 0;
    final hasFinance  = revenue > 0 || expense > 0;

    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.bgSurface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.divider),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header row
            Row(
              children: [
                Expanded(
                  child: Text(vehicleName,
                    style: const TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w600, fontSize: 15)),
                ),
                _StatusChip(status: status),
              ],
            ),
            const SizedBox(height: 8),

            // Time
            Text(fmtDate(trip['start_time'] as String?),
              style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),

            const SizedBox(height: 10),

            // Stats row
            Row(
              children: [
                _StatChip(icon: Icons.route, label: '${distKm.toStringAsFixed(1)} km'),
                const SizedBox(width: 8),
                if (trip['duration_minutes'] != null)
                  _StatChip(icon: Icons.timer_outlined, label: '${trip['duration_minutes']}m'),
                if (trip['fuel_consumed_litres'] != null) ...[
                  const SizedBox(width: 8),
                  _StatChip(icon: Icons.local_gas_station_outlined,
                    label: '${(double.tryParse(trip['fuel_consumed_litres'].toString()) ?? 0).toStringAsFixed(1)} L'),
                ],
              ],
            ),

            // Finance row (only when data present)
            if (hasFinance) ...[
              const SizedBox(height: 10),
              const Divider(color: AppColors.divider, height: 1),
              const SizedBox(height: 10),
              Row(
                children: [
                  _FinanceLabel(label: 'Revenue', value: rupee(revenue), color: const Color(0xFF4ADE80)),
                  const SizedBox(width: 16),
                  _FinanceLabel(label: 'Expenses', value: rupee(expense), color: const Color(0xFFFBBF24)),
                  const Spacer(),
                  _ProfitChip(profit: profit),
                ],
              ),
            ] else ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  const Icon(Icons.add_circle_outline, size: 14, color: AppColors.textLabel),
                  const SizedBox(width: 4),
                  Text('Tap to add revenue & expenses',
                    style: const TextStyle(color: AppColors.textLabel, fontSize: 12)),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  final String status;
  const _StatusChip({required this.status});

  @override
  Widget build(BuildContext context) {
    final isActive = status == 'active';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: isActive ? const Color(0xFF3B82F6).withOpacity(0.15) : const Color(0xFF22C55E).withOpacity(0.15),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (isActive)
            Container(
              width: 6, height: 6,
              margin: const EdgeInsets.only(right: 4),
              decoration: const BoxDecoration(color: Color(0xFF3B82F6), shape: BoxShape.circle),
            ),
          Text(
            isActive ? 'Active' : 'Completed',
            style: TextStyle(
              color: isActive ? const Color(0xFF3B82F6) : const Color(0xFF22C55E),
              fontSize: 11, fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _StatChip extends StatelessWidget {
  final IconData icon;
  final String label;
  const _StatChip({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Icon(icon, size: 14, color: AppColors.textLabel),
      const SizedBox(width: 3),
      Text(label, style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
    ],
  );
}

class _FinanceLabel extends StatelessWidget {
  final String label;
  final String value;
  final Color color;
  const _FinanceLabel({required this.label, required this.value, required this.color});

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(label, style: const TextStyle(color: AppColors.textLabel, fontSize: 11)),
      Text(value, style: TextStyle(color: color, fontSize: 13, fontWeight: FontWeight.w600)),
    ],
  );
}

class _ProfitChip extends StatelessWidget {
  final double profit;
  const _ProfitChip({required this.profit});

  @override
  Widget build(BuildContext context) {
    final positive = profit >= 0;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: positive
            ? const Color(0xFF22C55E).withOpacity(0.15)
            : const Color(0xFFEF4444).withOpacity(0.15),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            positive ? Icons.trending_up_rounded : Icons.trending_down_rounded,
            size: 13,
            color: positive ? const Color(0xFF22C55E) : const Color(0xFFEF4444),
          ),
          const SizedBox(width: 3),
          Text(
            '₹${profit.abs().toStringAsFixed(0)}',
            style: TextStyle(
              color: positive ? const Color(0xFF22C55E) : const Color(0xFFEF4444),
              fontSize: 13, fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}
