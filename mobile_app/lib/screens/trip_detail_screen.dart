import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:http/http.dart' as http;
import 'package:vehicle_telemetry/config/app_colors.dart';
import 'package:vehicle_telemetry/config/supabase_config.dart';

class TripDetailScreen extends StatefulWidget {
  final Map<String, dynamic> trip;
  const TripDetailScreen({Key? key, required this.trip}) : super(key: key);

  @override
  State<TripDetailScreen> createState() => _TripDetailScreenState();
}

class _TripDetailScreenState extends State<TripDetailScreen> {
  final _supabase = Supabase.instance.client;

  // Loaded from edge function
  Map<String, dynamic>? _expenses;
  Map<String, dynamic>? _revenue;
  bool _loading = true;
  String? _error;
  bool _saving = false;

  // Editable controllers
  late final TextEditingController _amountCtrl;
  late final TextEditingController _descCtrl;
  late final TextEditingController _tollCtrl;
  late final TextEditingController _allowanceCtrl;
  late final TextEditingController _otherCtrl;
  late final TextEditingController _notesCtrl;

  @override
  void initState() {
    super.initState();
    _amountCtrl    = TextEditingController();
    _descCtrl      = TextEditingController();
    _tollCtrl      = TextEditingController();
    _allowanceCtrl = TextEditingController();
    _otherCtrl     = TextEditingController();
    _notesCtrl     = TextEditingController();
    _loadDetail();
  }

  @override
  void dispose() {
    _amountCtrl.dispose();
    _descCtrl.dispose();
    _tollCtrl.dispose();
    _allowanceCtrl.dispose();
    _otherCtrl.dispose();
    _notesCtrl.dispose();
    super.dispose();
  }

  String get _edgeBase {
    final url = SupabaseConfig.supabaseUrl;
    return '$url/functions/v1/trip-expense-api';
  }

  Future<String?> get _token async {
    final session = _supabase.auth.currentSession;
    return session?.accessToken;
  }

  Future<void> _loadDetail() async {
    setState(() { _loading = true; _error = null; });
    try {
      final tok = await _token;
      final res = await http.get(
        Uri.parse('$_edgeBase?trip_id=${widget.trip['id']}'),
        headers: {'Authorization': 'Bearer $tok'},
      );
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode != 200) throw body['error'] ?? 'Failed to load';

      final exp = body['expenses'] as Map<String, dynamic>? ?? {};
      final rev = body['revenue']  as Map<String, dynamic>? ?? {};

      if (mounted) {
        setState(() {
          _expenses = exp;
          _revenue  = rev;
          _amountCtrl.text    = (rev['amount']           ?? 0).toString();
          _descCtrl.text      = (rev['description']      ?? '').toString();
          _tollCtrl.text      = (exp['toll_cost']        ?? 0).toString();
          _allowanceCtrl.text = (exp['driver_allowance'] ?? 0).toString();
          _otherCtrl.text     = (exp['other_cost']       ?? 0).toString();
          _notesCtrl.text     = (exp['notes']            ?? '').toString();
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) setState(() { _error = e.toString(); _loading = false; });
    }
  }

  Future<void> _save() async {
    setState(() { _saving = true; _error = null; });
    try {
      final tok = await _token;
      final headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $tok',
      };
      final tripId = widget.trip['id'] as String;

      final results = await Future.wait([
        http.post(Uri.parse(_edgeBase),
          headers: headers,
          body: jsonEncode({
            'action': 'upsert-expenses',
            'trip_id': tripId,
            'toll_cost':        double.tryParse(_tollCtrl.text)      ?? 0,
            'driver_allowance': double.tryParse(_allowanceCtrl.text) ?? 0,
            'other_cost':       double.tryParse(_otherCtrl.text)     ?? 0,
            'notes':            _notesCtrl.text,
          }),
        ),
        http.post(Uri.parse(_edgeBase),
          headers: headers,
          body: jsonEncode({
            'action': 'upsert-revenue',
            'trip_id': tripId,
            'amount':       double.tryParse(_amountCtrl.text) ?? 0,
            'description':  _descCtrl.text,
          }),
        ),
      ]);

      for (final res in results) {
        if (res.statusCode != 201) {
          final b = jsonDecode(res.body) as Map<String, dynamic>;
          throw b['error'] ?? 'Save failed';
        }
      }

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Saved successfully'),
          backgroundColor: AppColors.accentTeal,
          behavior: SnackBarBehavior.floating,
        ));
        Navigator.pop(context, true);
      }
    } catch (e) {
      if (mounted) setState(() { _error = e.toString(); _saving = false; });
    }
  }

  double get _liveProfit {
    final rev  = double.tryParse(_amountCtrl.text) ?? 0;
    final fuel = double.tryParse(_expenses?['fuel_cost']?.toString() ?? '0') ?? 0;
    final maint = double.tryParse(_expenses?['maintenance_cost']?.toString() ?? '0') ?? 0;
    final toll  = double.tryParse(_tollCtrl.text) ?? 0;
    final allow = double.tryParse(_allowanceCtrl.text) ?? 0;
    final other = double.tryParse(_otherCtrl.text) ?? 0;
    return rev - (fuel + maint + toll + allow + other);
  }

  @override
  Widget build(BuildContext context) {
    final trip        = widget.trip;
    final vehicleName = (trip['vehicles'] as Map?)?['name'] as String? ?? 'Trip';
    final distKm      = double.tryParse(trip['distance_km']?.toString() ?? '0') ?? 0;
    final fuelL       = double.tryParse(trip['fuel_consumed_litres']?.toString() ?? '0') ?? 0;
    final duration    = trip['duration_minutes'];

    return Scaffold(
      backgroundColor: AppColors.bgPrimary,
      appBar: AppBar(
        backgroundColor: AppColors.bgSurface,
        elevation: 0,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(vehicleName,
              style: const TextStyle(color: AppColors.textPrimary, fontSize: 16, fontWeight: FontWeight.w700)),
            if (trip['start_time'] != null)
              Text(_fmtDate(trip['start_time'] as String),
                style: const TextStyle(color: AppColors.textLabel, fontSize: 11)),
          ],
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.accentBlue))
          : SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (_error != null)
                    _ErrorCard(message: _error!),

                  // Trip stats
                  Row(
                    children: [
                      _StatTile(label: 'Distance', value: '${distKm.toStringAsFixed(1)} km'),
                      const SizedBox(width: 8),
                      _StatTile(label: 'Duration', value: duration != null ? '${duration}m' : '—'),
                      const SizedBox(width: 8),
                      _StatTile(label: 'Fuel', value: fuelL > 0 ? '${fuelL.toStringAsFixed(2)} L' : '—'),
                    ],
                  ),
                  const SizedBox(height: 20),

                  // Revenue section
                  _SectionHeader(label: 'Revenue'),
                  const SizedBox(height: 8),
                  _InputCard(children: [
                    _FieldRow(label: 'Amount (₹)', controller: _amountCtrl, keyboardType: TextInputType.number),
                    const SizedBox(height: 10),
                    _FieldRow(label: 'Description', controller: _descCtrl, hint: 'e.g. Delivery charge'),
                  ]),
                  const SizedBox(height: 16),

                  // Expenses section
                  _SectionHeader(label: 'Expenses'),
                  const SizedBox(height: 8),
                  _InputCard(children: [
                    _ReadOnlyRow(
                      label: 'Fuel Cost (auto)',
                      value: '₹${(double.tryParse(_expenses?['fuel_cost']?.toString() ?? '0') ?? 0).toStringAsFixed(0)}',
                      estimated: _expenses?['_estimated'] == true,
                    ),
                    const SizedBox(height: 8),
                    _ReadOnlyRow(
                      label: 'Maintenance (auto)',
                      value: '₹${(double.tryParse(_expenses?['maintenance_cost']?.toString() ?? '0') ?? 0).toStringAsFixed(0)}',
                      estimated: _expenses?['_estimated'] == true,
                    ),
                    const Divider(color: AppColors.divider, height: 20),
                    _FieldRow(label: 'Toll Cost (₹)', controller: _tollCtrl, keyboardType: TextInputType.number),
                    const SizedBox(height: 10),
                    _FieldRow(label: 'Driver Allowance (₹)', controller: _allowanceCtrl, keyboardType: TextInputType.number),
                    const SizedBox(height: 10),
                    _FieldRow(label: 'Other (₹)', controller: _otherCtrl, keyboardType: TextInputType.number),
                    const SizedBox(height: 10),
                    _FieldRow(label: 'Notes', controller: _notesCtrl, maxLines: 2, hint: 'Optional…'),
                  ]),

                  if (_expenses?['_estimated'] == true)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        '* Fuel & maintenance auto-calculated from telemetry',
                        style: const TextStyle(color: Color(0xFFF59E0B), fontSize: 11),
                      ),
                    ),

                  const SizedBox(height: 20),

                  // Live profit preview
                  _ProfitPreview(
                    revenue:  double.tryParse(_amountCtrl.text) ?? 0,
                    expense:  _liveProfit < 0
                        ? (double.tryParse(_amountCtrl.text) ?? 0) - _liveProfit
                        : (double.tryParse(_amountCtrl.text) ?? 0) - _liveProfit,
                    profit:   _liveProfit,
                  ),

                  const SizedBox(height: 20),

                  // Save button
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton.icon(
                      onPressed: _saving ? null : _save,
                      icon: _saving
                          ? const SizedBox(
                              width: 16, height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                          : const Icon(Icons.save_rounded),
                      label: Text(_saving ? 'Saving…' : 'Save'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.accentBlue,
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                    ),
                  ),
                  const SizedBox(height: 24),
                ],
              ),
            ),
    );
  }

  String _fmtDate(String iso) {
    final d = DateTime.tryParse(iso)?.toLocal();
    if (d == null) return '';
    return '${d.day.toString().padLeft(2, '0')} '
        '${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.month - 1]} '
        '${d.year}  '
        '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }
}

// ── Reusable sub-widgets ──────────────────────────────────────────────────────

class _SectionHeader extends StatelessWidget {
  final String label;
  const _SectionHeader({required this.label});

  @override
  Widget build(BuildContext context) => Text(
    label.toUpperCase(),
    style: const TextStyle(color: AppColors.textLabel, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 0.8),
  );
}

class _InputCard extends StatelessWidget {
  final List<Widget> children;
  const _InputCard({required this.children});

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: AppColors.bgSurface,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: AppColors.divider),
    ),
    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
  );
}

class _FieldRow extends StatelessWidget {
  final String label;
  final TextEditingController controller;
  final TextInputType keyboardType;
  final String? hint;
  final int maxLines;

  const _FieldRow({
    required this.label,
    required this.controller,
    this.keyboardType = TextInputType.text,
    this.hint,
    this.maxLines = 1,
  });

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(label, style: const TextStyle(color: AppColors.textLabel, fontSize: 12)),
      const SizedBox(height: 4),
      TextField(
        controller: controller,
        keyboardType: keyboardType,
        maxLines: maxLines,
        style: const TextStyle(color: AppColors.textPrimary, fontSize: 14),
        cursorColor: AppColors.accentBlue,
        decoration: InputDecoration(
          hintText: hint,
          hintStyle: const TextStyle(color: AppColors.textLabel),
          filled: true,
          fillColor: AppColors.bgPrimary,
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: AppColors.divider),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: AppColors.accentBlue, width: 1.5),
          ),
        ),
      ),
    ],
  );
}

class _ReadOnlyRow extends StatelessWidget {
  final String label;
  final String value;
  final bool estimated;
  const _ReadOnlyRow({required this.label, required this.value, this.estimated = false});

  @override
  Widget build(BuildContext context) => Row(
    mainAxisAlignment: MainAxisAlignment.spaceBetween,
    children: [
      Text(label, style: const TextStyle(color: AppColors.textSecondary, fontSize: 13)),
      Row(
        children: [
          if (estimated)
            const Padding(
              padding: EdgeInsets.only(right: 4),
              child: Icon(Icons.auto_awesome, size: 12, color: Color(0xFFF59E0B)),
            ),
          Text(value, style: const TextStyle(color: AppColors.textPrimary, fontSize: 13, fontWeight: FontWeight.w600)),
        ],
      ),
    ],
  );
}

class _ProfitPreview extends StatelessWidget {
  final double revenue;
  final double expense;
  final double profit;
  const _ProfitPreview({required this.revenue, required this.expense, required this.profit});

  @override
  Widget build(BuildContext context) {
    final positive = profit >= 0;
    final border   = positive ? const Color(0xFF22C55E) : const Color(0xFFEF4444);
    final bg       = border.withOpacity(0.08);

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: border.withOpacity(0.3)),
      ),
      child: Column(
        children: [
          _PreviewRow(label: 'Revenue', value: '₹${revenue.toStringAsFixed(0)}', color: AppColors.textPrimary),
          const SizedBox(height: 6),
          _PreviewRow(
            label: 'Total Expenses',
            value: '₹${(revenue - profit).toStringAsFixed(0)}',
            color: AppColors.textSecondary,
          ),
          const Divider(color: AppColors.divider, height: 16),
          _PreviewRow(
            label: 'Net Profit',
            value: '₹${profit.abs().toStringAsFixed(0)}',
            color: positive ? const Color(0xFF22C55E) : const Color(0xFFEF4444),
            bold: true,
            prefix: positive ? null : '-',
          ),
        ],
      ),
    );
  }
}

class _PreviewRow extends StatelessWidget {
  final String  label;
  final String  value;
  final Color   color;
  final bool    bold;
  final String? prefix;
  const _PreviewRow({required this.label, required this.value, required this.color, this.bold = false, this.prefix});

  @override
  Widget build(BuildContext context) => Row(
    mainAxisAlignment: MainAxisAlignment.spaceBetween,
    children: [
      Text(label, style: TextStyle(color: color, fontSize: 13, fontWeight: bold ? FontWeight.w700 : FontWeight.normal)),
      Text('${prefix ?? ''}$value', style: TextStyle(color: color, fontSize: 13, fontWeight: bold ? FontWeight.w700 : FontWeight.w600)),
    ],
  );
}

class _StatTile extends StatelessWidget {
  final String label;
  final String value;
  const _StatTile({required this.label, required this.value});

  @override
  Widget build(BuildContext context) => Expanded(
    child: Container(
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 10),
      decoration: BoxDecoration(
        color: AppColors.bgSurface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.divider),
      ),
      child: Column(
        children: [
          Text(value, style: const TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w700, fontSize: 14)),
          const SizedBox(height: 2),
          Text(label, style: const TextStyle(color: AppColors.textLabel, fontSize: 11)),
        ],
      ),
    ),
  );
}

class _ErrorCard extends StatelessWidget {
  final String message;
  const _ErrorCard({required this.message});

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 12),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: const Color(0xFFEF4444).withOpacity(0.15),
      borderRadius: BorderRadius.circular(10),
      border: Border.all(color: const Color(0xFFEF4444).withOpacity(0.4)),
    ),
    child: Text(message, style: const TextStyle(color: Color(0xFFEF4444), fontSize: 13)),
  );
}
