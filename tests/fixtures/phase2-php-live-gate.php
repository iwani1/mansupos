<?php
// Synthetic only. No WordPress, Woo DB, HTTP, stock or real payments.
define( 'ABSPATH', '/synthetic/' );
$scenario = getenv( 'MANSU_BRIDGE_GATE_CASE' ) ?: 'valid';
define( 'MANSU_ONLINE_BRIDGE_ENABLED', true );
define( 'MANSU_ONLINE_BRIDGE_SERVICE', $scenario === 'wrong-service' ? 'staging' : 'live-trading' );
define( 'MANSU_ONLINE_BRIDGE_LEDGER_ID', 'ba0c917e-6278-4aaf-b89d-d87f39a39762' );
define( 'MANSU_ONLINE_BRIDGE_SITE_ID', '72b1645b-bc7e-4be4-924d-3d3b9dbfbe89' );
define( 'MANSU_ONLINE_BRIDGE_LIVE_ACCEPTED', $scenario !== 'unaccepted' );
define( 'MANSU_ONLINE_BRIDGE_LIVE_ACCEPTANCE_REFERENCE', $scenario === 'short-reference' ? 'short' : 'synthetic-separate-owner-acceptance' );
define( 'MANSU_ONLINE_BRIDGE_SITE_HOST', $scenario === 'wrong-host' ? 'unrelated.example' : 'www.mansutrendzgh.com' );
function wp_get_environment_type() { return getenv( 'MANSU_BRIDGE_GATE_CASE' ) === 'wrong-environment' ? 'local' : 'production'; }
function home_url() { return getenv( 'MANSU_BRIDGE_GATE_CASE' ) === 'site-mismatch' ? 'https://different.example' : 'https://www.mansutrendzgh.com'; }
function wp_parse_url( $url, $part ) { return parse_url( $url, $part ); }
function is_ssl() { return getenv( 'MANSU_BRIDGE_GATE_CASE' ) !== 'no-tls'; }
function register_activation_hook( $file, $function ) {}
function add_action( $hook, $function, $priority = 10, $argc = 1 ) {}
/* @INSERT_BRIDGE_PLUGIN@ */
$enabled = mansu_online_enabled();
$expected = $scenario === 'valid';
if ( $enabled !== $expected ) {
    fwrite( STDERR, 'Invalid synthetic live bridge gate state for ' . $scenario . PHP_EOL );
    exit( 1 );
}
echo "LIVE_BRIDGE_GATE_OK " . $scenario . PHP_EOL;
