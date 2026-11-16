<?php
// Disposable-only PHP stubs. No WordPress, Paystack, MySQL, network or money.
// The uninstalled bridge source is injected by tests/online-bridge-php-native.mjs.
define( 'ABSPATH', '/synthetic/' );
define( 'ARRAY_A', 'ARRAY_A' );
define( 'MANSU_ONLINE_BRIDGE_ENABLED', true );
define( 'MANSU_ONLINE_BRIDGE_SERVICE', 'staging' );
define( 'MANSU_ONLINE_BRIDGE_LEDGER_ID', 'ba0c917e-6278-4aaf-b89d-d87f39a39762' );
define( 'MANSU_ONLINE_BRIDGE_SITE_ID', '72b1645b-bc7e-4be4-924d-3d3b9dbfbe89' );
define( 'WC_PAYSTACK_VERSION', '5.8.6' );

function wp_get_environment_type() { return 'local'; }
function register_activation_hook( $file, $handler ) {}
function add_action( $hook, $handler, $priority = 10, $argc = 1 ) {}
function add_filter( $hook, $handler, $priority = 10, $argc = 1 ) {}
class WP_Error {
    public function __construct( public $code, public $message, public $data = null ) {}
}
class FakeTokenProduct {
    public function managing_stock() { return true; }
    public function backorders_allowed() { return false; }
    public function get_stock_managed_by_id() { return 6312; }
}
class FakeTokenLine {
    public function get_product() { return new FakeTokenProduct(); }
    public function get_quantity() { return 1; }
    public function get_meta( $key, $single = true ) { return 0; }
}
class WC_Order {
    public string $status = 'pending';
    public string $created_via = 'checkout';
    public string $reference = '901_1794841200';
    public bool $review = false;
    public function get_id() { return 901; }
    public function get_created_via() { return $this->created_via; }
    public function get_payment_method() { return 'paystack'; }
    public function get_date_paid() { return null; }
    public function has_status( $status ) { return in_array( $this->status, (array) $status, true ); }
    public function get_total() { return '100.00'; }
    public function get_currency() { return 'GHS'; }
    public function get_meta( $key, $single = true ) {
        if ( $key === '_paystack_txn_ref' ) { return $this->reference; }
        if ( $key === '_mansu_website_stock_review' && $this->review ) { return 'required'; }
        return '';
    }
    public function get_items( $type = 'line_item' ) { return array( 1 => new FakeTokenLine() ); }
}
$GLOBALS['test_order'] = new WC_Order();
function wc_get_order( $id ) { return (int) $id === 901 ? $GLOBALS['test_order'] : false; }
class FakeTokenDB {
    public $wc_reserved_stock = 'wp_wc_reserved_stock';
    public $posts = 'wp_posts';
    public $prefix = 'wp_';
    public int $remaining = 600;
    public bool $missing = false;
    public bool $lock_available = true;
    public bool $lock_lost = false;
    public bool $owned = false;
    public function prepare( $sql, ...$params ) { return array( $sql, $params ); }
    public function get_results( $query, $format = null ) {
        if ( $this->missing ) { return array(); }
        return array( array( 'product_id' => 6312, 'stock_quantity' => 1,
            'remaining' => $this->remaining ) );
    }
    public function get_var( $query ) {
        $sql = $query[0];
        if ( str_contains( $sql, 'GET_LOCK(' ) ) {
            if ( ! $this->lock_available ) { return '0'; }
            $this->owned = true;
            return '1';
        }
        if ( str_contains( $sql, 'IS_USED_LOCK(' ) ) {
            return $this->owned && ! $this->lock_lost ? '1' : '0';
        }
        if ( str_contains( $sql, 'RELEASE_LOCK(' ) ) {
            $this->owned = false;
            return '1';
        }
        if ( str_contains( $sql, 'SELECT post_status FROM wp_posts WHERE id=' ) ) {
            // The real gateway guard reads canonical status under the MySQL
            // lock. This fixture models that read from its isolated order;
            // never reaches a merchant DB or a real WordPress installation.
            return 'wc-' . $GLOBALS['test_order']->status;
        }
        throw new RuntimeException( 'Unknown synthetic advisory lock query.' );
    }
}
$GLOBALS['wpdb'] = new FakeTokenDB();
class WC_Gateway_Paystack {
    public function process_token_payment( $payload, $url = 'https://api.paystack.co/transaction/charge_authorization', $method = 'POST' ) {
        // Use the exact upstream method name to exercise backtrace scope,
        // but do NOT fake or claim any Paystack transaction/settlement.
        return mansu_online_paystack_saved_token_precharge( false,
            array( 'method' => $method, 'body' => json_encode( $payload ) ), $url );
    }
}
function token_check( $result, $why ) {
    ++$GLOBALS['token_checks'];
    if ( ! $result ) { throw new RuntimeException( $why ); }
}
$GLOBALS['token_checks'] = 0;
/* @INSERT_BRIDGE_PLUGIN@ */
$gateway = new WC_Gateway_Paystack();
$payload = array( 'reference' => '901_1794841200', 'amount' => 10000, 'currency' => 'GHS' );
token_check( mansu_online_paystack_token_charge_matches( $GLOBALS['test_order'], $payload ),
    'Original order/hold reference was not admitted.' );
token_check( $gateway->process_token_payment( $payload ) === false,
    'Valid saved-token precharge should allow native HTTP to continue.' );
token_check( $GLOBALS['wpdb']->owned, 'Valid token path did not hold order advisory lock.' );
$GLOBALS['wpdb']->remaining = 45;
token_check( $gateway->process_token_payment( $payload ) instanceof WP_Error,
    'Near-expiry original hold was not rejected before charge.' );
$GLOBALS['wpdb']->remaining = -30;
token_check( $gateway->process_token_payment( $payload ) instanceof WP_Error,
    'Expired original hold was not rejected before charge.' );
$GLOBALS['wpdb']->remaining = 600;
$GLOBALS['wpdb']->missing = true;
token_check( $gateway->process_token_payment( $payload ) instanceof WP_Error,
    'Missing original hold was not rejected.' );
$GLOBALS['wpdb']->missing = false;
foreach ( array( 'reference', 'amount', 'currency' ) as $key ) {
    $wrong = $payload;
    $wrong[$key] = $key === 'reference' ? '901_1794841201' :
        ( $key === 'amount' ? 9900 : 'NGN' );
    token_check( $gateway->process_token_payment( $wrong ) instanceof WP_Error,
        'Changed token charge ' . $key . ' reached Paystack.' );
}
$GLOBALS['test_order']->status = 'on-hold';
token_check( $gateway->process_token_payment( $payload ) instanceof WP_Error,
    'Nonpending website order reached saved-card charge.' );
$GLOBALS['test_order']->status = 'pending';
$GLOBALS['test_order']->review = true;
token_check( $gateway->process_token_payment( $payload ) instanceof WP_Error,
    'Quarantined website order reached saved-card charge.' );
$GLOBALS['test_order']->review = false;
token_check( $gateway->process_token_payment( $payload, 'https://example.invalid/not-paystack' ) === false,
    'Other outbound integrations were intercepted.' );
token_check( $gateway->process_token_payment( $payload, 'https://api.paystack.co/transaction/charge_authorization', 'GET' ) instanceof WP_Error,
    'Unexpected method was permitted to issue saved-card charge.' );
$GLOBALS['wpdb']->lock_lost = true;
token_check( $gateway->process_token_payment( $payload ) instanceof WP_Error,
    'Lost advisory-lock ownership was permitted to charge.' );
$GLOBALS['wpdb']->lock_lost = false;
token_check( $gateway->process_token_payment( $payload ) === false,
    'Original valid charge was not recovered after lock ownership check.' );
echo 'PAYSTACK_TOKEN_PRECHARGE_SYNTHETIC_OK ' . $GLOBALS['token_checks'] . ' isolated checks' . PHP_EOL;
