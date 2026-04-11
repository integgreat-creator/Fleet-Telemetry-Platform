import 'package:flutter/material.dart';

/// Centralised dark-navy colour palette matching the VehicleSense brand theme.
/// Every screen and widget imports from here so a single change propagates app-wide.
class AppColors {
  AppColors._();

  // ── Backgrounds ────────────────────────────────────────────────────────────
  /// Main scaffold background — very dark navy-black
  static const Color bgPrimary    = Color(0xFF090E1A);
  /// Card / list-tile background
  static const Color bgCard       = Color(0xFF0F1829);
  /// Slightly lighter card variant (nested items, dialogs)
  static const Color bgCardAlt    = Color(0xFF141E33);
  /// AppBar / BottomNav background
  static const Color bgSurface    = Color(0xFF0C1220);

  // ── Icon containers ────────────────────────────────────────────────────────
  /// Muted dark-blue circle/box behind icons
  static const Color iconBg       = Color(0xFF1A2D4D);

  // ── Accent ─────────────────────────────────────────────────────────────────
  /// Primary blue accent (buttons, active icons, toggles, active nav item)
  static const Color accentBlue   = Color(0xFF3B82F6);
  /// Teal accent kept for CTAs that used 00BFA5 before
  static const Color accentTeal   = Color(0xFF00BFA5);

  // ── Text ───────────────────────────────────────────────────────────────────
  static const Color textPrimary   = Color(0xFFFFFFFF);
  static const Color textSecondary = Color(0xFF8994B0);
  /// Section header labels (uppercase, small)
  static const Color textLabel     = Color(0xFF6B7280);

  // ── Borders / dividers ─────────────────────────────────────────────────────
  static const Color divider      = Color(0xFF151F35);

  // ── Status ─────────────────────────────────────────────────────────────────
  static const Color statusConnected    = Color(0xFF22C55E);  // green-500
  static const Color statusConnecting   = Color(0xFFF59E0B);  // amber-500
  static const Color statusDisconnected = Color(0xFF64748B);  // slate-500
  static const Color statusError        = Color(0xFFEF4444);  // red-500
}
