<?php
// Synthetic WordPress/Woo stub runtime. There is NO WordPress, MySQL, gateway,
// SMTP, external HTTP, real account, order or stock in this exercise.
namespace Automattic\WooCommerce\Checkout\Helpers {
    class ReserveStock {
        public function reserve_stock_for_order( $order, $minutes ) {
            $required = array();
            foreach ( $order->get_items( 'line_item' ) as $line ) {
                $id = $line->get_product()->get_stock_managed_by_id();
                $required[ $id ] = ( $required[ $id ] ?? 0 ) + $line->get_quantity();
            }
            foreach ( $required as $owner => $quantity ) {
                $already = 0;
                foreach ( $GLOBALS['holds'] as $current ) {
                    if ( isset( $current[ $owner ] ) && $current[ $owner ]['until'] > time() ) {
                        $already += $current[ $owner ]['quantity'];
                    }
                }
                if ( $GLOBALS['stock'][ $owner ] - $already < $quantity ) {
                    throw new \RuntimeException( 'Synthetic Woo last unit is held.' );
                }
            }
            foreach ( $required as $owner => $quantity ) {
                $GLOBALS['holds'][ $order->get_id() ][ $owner ] = array(
                    'quantity' => $quantity, 'until' => time() + $minutes * 60 );
            }
        }
    }
}
namespace {
const ABSPATH = '/synthetic/';
const ARRAY_A = 'ARRAY_A';
const WC_VERSION = '11.0.1';
const MANSU_ONLINE_BRIDGE_ENABLED = true;
const MANSU_ONLINE_BRIDGE_SERVICE = 'staging';
const MANSU_ONLINE_BRIDGE_LEDGER_ID = 'ba0c917e-6278-4aaf-b89d-d87f39a39762';
const MANSU_ONLINE_BRIDGE_SITE_ID = '72b1645b-bc7e-4be4-924d-3d3b9dbfbe89';
const MANSU_ONLINE_BRIDGE_SECRET = 'only-local-synthetic-secret-for-test-fixtures';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$GLOBALS['stock'] = array( 10 => 1 );
$GLOBALS['holds'] = array();
$GLOBALS['orders'] = array();
$GLOBALS['checks'] = 0;
$GLOBALS['creates'] = 0;
$GLOBALS['payments'] = 0;
$GLOBALS['jobs'] = 0;
$GLOBALS['tax'] = false;
$GLOBALS['failHoldCount'] = false;
function check( $test, $message ) {
    ++$GLOBALS['checks'];
    if ( ! $test ) { throw new \RuntimeException( $message ); }
}
class WP_Error {
    public function __construct( public $code, public $message, public $data ) {}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function wp_get_environment_type() { return 'local'; }
function current_user_can( $cap ) { return $cap === 'mansu_online_bridge'; }
function is_ssl() { return false; }
function register_activation_hook( $file, $handler ) {}
function add_action( $hook, $handler, $priority = 10, $arguments = 1 ) {}
function wp_json_encode( $value ) { return json_encode( $value ); }
function current_time( $type, $gmt ) { return gmdate( 'Y-m-d H:i:s' ); }
function get_option( $key, $default = false ) {
    return $key === 'woocommerce_schema_version' ? 430 : ( $key === 'woocommerce_manage_stock' ? 'yes' : $default );
}
function apply_filters( $name, $value ) { return $value; }
function get_woocommerce_currency() { return 'GHS'; }
function wc_tax_enabled() { return $GLOBALS['tax']; }
function wc_release_stock_for_order( $order ) { unset( $GLOBALS['holds'][ $order->get_id() ] ); }
function as_schedule_single_action( $timestamp, $hook, $args, $group ) { return ++$GLOBALS['jobs']; }
class WP_REST_Request implements \ArrayAccess {
    private $headers = array(); private $params = array();
    public function __construct( private $method, private $route, private $body = '' ) {}
    public function set_header( $name, $value ) { $this->headers[ strtolower( $name ) ] = $value; }
    public function get_header( $name ) { return $this->headers[ strtolower( $name ) ] ?? ''; }
    public function get_body() { return $this->body; }
    public function get_method() { return $this->method; }
    public function get_route() { return $this->route; }
    public function get_json_params() { return json_decode( $this->body, true ); }
    public function set_param( $key, $value ) { $this->params[ $key ] = $value; }
    public function offsetExists( $key ): bool { return isset( $this->params[ $key ] ); }
    public function offsetGet( $key ): mixed { return $this->params[ $key ] ?? null; }
    public function offsetSet( $key, $value ): void { $this->params[ $key ] = $value; }
    public function offsetUnset( $key ): void { unset( $this->params[ $key ] ); }
}
function request( $method, $route, $body = '' ) {
    $req = new WP_REST_Request( $method, $route, $body );
    $time = (string) time();
    $req->set_header( 'x-mansu-bridge-timestamp', $time );
    $req->set_header( 'x-mansu-bridge-signature', hash_hmac( 'sha256',
        $time . "\n" . $method . "\n" . $route . "\n" . hash( 'sha256', $body ), MANSU_ONLINE_BRIDGE_SECRET ) );
    check( mansu_online_permission( $req ) === true, 'Service authorization failed.' );
    return $req;
}
class FakeDatabase {
    public $prefix = 'wp_';
    public $wc_reserved_stock = 'wp_wc_reserved_stock';
    public $posts = 'wp_posts';
    public $postmeta = 'wp_postmeta';
    public $attempts = array();
    public function prepare( $sql, ...$params ) { return array( 'sql' => $sql, 'params' => $params ); }
    public function get_charset_collate() { return 'DEFAULT CHARSET=utf8mb4'; }
    public function get_var( $query ) {
        $sql = $query['sql'];
        if ( str_contains( $sql, 'information_schema.TABLES' ) ) { return 'InnoDB'; }
        if ( str_contains( $sql, 'COUNT(*) FROM ' . $this->wc_reserved_stock ) ) {
            if ( $GLOBALS['failHoldCount'] ) { return null; }
            return (string) count( $GLOBALS['holds'][ $query['params'][0] ] ?? array() );
        }
        throw new \RuntimeException( 'Unexpected synthetic DB scalar query.' );
    }
    public function get_row( $query, $output ) {
        return $this->attempts[ $query['params'][1] ] ?? null;
    }
    public function get_results( $query, $output ) {
        $order = $query['params'][0]; $result = array();
        foreach ( $GLOBALS['holds'][ $order ] ?? array() as $owner => $hold ) {
            $result[] = array( 'product_id' => $owner, 'stock_quantity' => $hold['quantity'],
                'remaining' => $hold['until'] - time() );
        }
        return $result;
    }
    public function query( $query ) {
        if ( ! str_contains( $query['sql'], 'INSERT IGNORE INTO ' ) ) { throw new \RuntimeException( 'Unexpected SQL mutation.' ); }
        list( $service, $key, $ledger, $fingerprint, $hash, $items, $context ) = $query['params'];
        if ( isset( $this->attempts[ $key ] ) ) { return 0; }
        $this->attempts[ $key ] = array( 'service' => $service, 'attempt_key' => $key,
            'ledger_id' => $ledger, 'fingerprint' => $fingerprint, 'payload_hash' => $hash,
            'items_json' => $items, 'context_json' => $context, 'state' => 'claimed',
            'order_id' => null, 'total_cents' => 0, 'tax_cents' => 0,
            'created_at' => gmdate( 'Y-m-d H:i:s' ), 'updated_at' => gmdate( 'Y-m-d H:i:s' ) );
        return 1;
    }
    public function update( $table, $changes, $where ) {
        $key = $where['attempt_key'];
        if ( ! isset( $this->attempts[ $key ] ) || $this->attempts[ $key ]['service'] !== $where['service'] ||
             isset( $where['state'] ) && $this->attempts[ $key ]['state'] !== $where['state'] ) { return 0; }
        $this->attempts[ $key ] = array_merge( $this->attempts[ $key ], $changes );
        return 1;
    }
}
$GLOBALS['wpdb'] = new FakeDatabase();
class FakeProduct {
    public function __construct( public $id, public $kind, public $owner, public $sku ) {}
    public function is_type( $kind ) { return $kind === $this->kind; }
    public function get_parent_id() { return $this->kind === 'variation' ? 10 : 0; }
    public function get_status() { return 'publish'; }
    public function is_purchasable() { return true; }
    public function is_in_stock() { return $GLOBALS['stock'][ $this->owner ] > 0; }
    public function is_virtual() { return false; }
    public function is_downloadable() { return false; }
    public function backorders_allowed() { return false; }
    public function is_sold_individually() { return false; }
    public function get_price() { return '100.00'; }
    public function get_sku() { return $this->sku; }
    public function get_stock_managed_by_id() { return $this->owner; }
    public function managing_stock() { return true; }
    public function get_stock_quantity() { return $GLOBALS['stock'][ $this->owner ]; }
}
$GLOBALS['products'] = array(
    10 => new FakeProduct( 10, 'variable', 10, 'PARENT' ),
    11 => new FakeProduct( 11, 'variation', 10, 'VAR-11' ),
    12 => new FakeProduct( 12, 'variation', 10, 'VAR-12' ),
);
function wc_get_product( $id ) { return $GLOBALS['products'][ $id ] ?? false; }
class FakeLine {
    private $reduced = 0;
    public function __construct( private $product, private $quantity, private $total ) {}
    public function get_product_id() { return $this->product->kind === 'variation' ? 10 : $this->product->id; }
    public function get_variation_id() { return $this->product->kind === 'variation' ? $this->product->id : 0; }
    public function get_product() { return $this->product; }
    public function get_quantity() { return $this->quantity; }
    public function get_total() { return $this->total; }
    public function get_subtotal() { return $this->total; }
    public function get_total_tax() { return '0.00'; }
    public function set_total( $value ) { $this->total = $value; }
    public function set_subtotal( $value ) { $this->total = $value; }
    public function get_meta( $key, $single ) { return $key === '_reduced_stock' ? $this->reduced : null; }
    public function reduce() { $this->reduced = $this->quantity; }
    public function save() {}
}
class FakeMeta {
    public function __construct( private $key, private $value ) {}
    public function get_data() { return array( 'key' => $this->key, 'value' => $this->value ); }
}
class FakeStore {
    public function __construct( private $order ) {}
    public function get_stock_reduced( $id ) { return $this->order->reduced; }
}
class FakeDate extends \DateTimeImmutable {
    public function date( $format ) { return $this->format( $format ); }
}
class FakeOrder {
    public $reduced = false;
    private $meta = array(); private $items = array(); private $total = '0.00';
    private $currency = 'GHS'; private $method = ''; private $buyer = '';
    private $status = 'pending'; private $paid_at = null;
    public function __construct( private $id ) {}
    public function get_id() { return $this->id; }
    public function set_created_via( $value ) {}
    public function set_currency( $value ) { $this->currency = $value; }
    public function get_currency() { return $this->currency; }
    public function set_payment_method( $value ) { $this->method = $value; }
    public function get_payment_method() { return $this->method; }
    public function set_billing_first_name( $value ) { $this->buyer = $value; }
    public function get_billing_first_name() { return $this->buyer; }
    public function update_meta_data( $key, $value ) { $this->meta[ $key ] = $value; }
    public function get_meta( $key, $single = true ) { return $this->meta[ $key ] ?? ''; }
    public function get_meta_data() {
        $data = array();
        foreach ( $this->meta as $key => $value ) { $data[] = new FakeMeta( $key, $value ); }
        return $data;
    }
    public function add_product( $product, $quantity ) {
        $id = count( $this->items ) + 1;
        $this->items[ $id ] = new FakeLine( $product, $quantity,
            number_format( $quantity * (float) $product->get_price(), 2, '.', '' ) );
        return $id;
    }
    public function get_items( $kind = 'line_item' ) { return $kind === 'line_item' ? $this->items : array(); }
    public function get_item( $id ) { return $this->items[ $id ] ?? false; }
    public function calculate_totals( $tax = true ) {
        $this->total = number_format( array_reduce( $this->items, static fn( $sum, $line ) =>
            $sum + (float) $line->get_total(), 0 ), 2, '.', '' );
    }
    public function save() { $GLOBALS['orders'][ $this->id ] = $this; }
    public function get_total() { return $this->total; }
    public function get_total_tax() { return '0.00'; }
    public function get_shipping_total() { return '0.00'; }
    public function get_discount_total() { return '0.00'; }
    public function get_total_refunded() { return '0.00'; }
    public function has_status( $values ) { return in_array( $this->status, (array) $values, true ); }
    public function get_date_paid() { return $this->paid_at; }
    public function get_data_store() { return new FakeStore( $this ); }
    public function update_status( $new_status, $note = '' ) { $this->status = $new_status; }
    public function payment_complete() {
        if ( ! $this->has_status( 'pending' ) ) { return false; }
        ++$GLOBALS['payments'];
        $this->status = 'processing'; $this->paid_at = new FakeDate( 'now', new \DateTimeZone( 'UTC' ) );
        foreach ( $this->items as $line ) {
            $owner = $line->get_product()->get_stock_managed_by_id();
            $GLOBALS['stock'][ $owner ] -= $line->get_quantity();
            $line->reduce();
        }
        $this->reduced = true;
        wc_release_stock_for_order( $this );
        return true;
    }
}
function wc_create_order( $args ) {
    $id = 200 + ++$GLOBALS['creates'];
    $order = new FakeOrder( $id );
    $order->save();
    return $order;
}
function wc_get_order( $id ) { return $GLOBALS['orders'][ $id ] ?? false; }
/* @INSERT_BRIDGE_PLUGIN@ */
function input( $key, $variation = 11, $type = 'retail' ) {
    $result = array( 'service' => 'staging', 'ledgerId' => MANSU_ONLINE_BRIDGE_LEDGER_ID,
        'key' => $key, 'fingerprint' => str_repeat( 'a', 64 ),
        'cashierId' => 'a9a0e559-818e-444f-9cd6-99ee5f3e11da',
        'shiftId' => '98df372a-2586-460f-b8a2-5b56dc79666d', 'saleType' => $type,
        'items' => array( array( 'productId' => 10, 'variationId' => $variation, 'quantity' => 1,
            'expectedUnitCents' => 10000, 'ownerId' => 10, 'sku' => 'VAR-' . $variation ) ) );
    if ( $type === 'wholesale' ) {
        $result['items'][0]['agreedUnitCents'] = 7200;
        $result['quoteHash'] = str_repeat( 'b', 64 );
        $result['approvedBy'] = $result['cashierId'];
        $result['approvedAt'] = '2026-11-14T03:00:00.000Z';
        $result['buyerId'] = ''; $result['buyerName'] = 'Synthetic Buyer';
    }
    return $result;
}
$key = 'fb89eb6f-4cd5-4777-87a4-e49bfb978b81';
$create_request = request( 'POST', '/mansu-pos/v1/attempts', json_encode( input( $key ) ) );
$created = mansu_online_attempt( $create_request );
check( ! is_wp_error( $created ) && $created['state'] === 'reserved' && $created['reservationVerified'], 'First Woo hold not verified.' );
check( $created['totalCents'] === 10000 && $created['items'][0]['ownerId'] === 10, 'Wrong Woo gross or parent stock owner.' );
check( $GLOBALS['stock'][10] === 1 && count( $GLOBALS['holds'] ) === 1, 'Hold changed raw stock or disappeared.' );
$replayed = mansu_online_attempt( $create_request );
check( ! is_wp_error( $replayed ) && $GLOBALS['creates'] === 1 && $GLOBALS['jobs'] === 1 &&
    $replayed['expiresAt'] === $created['expiresAt'], 'Same-key replay created a new order or renewed a hold.' );
$altered = input( $key, 12 );
check( is_wp_error( mansu_online_attempt( request( 'POST', '/mansu-pos/v1/attempts', json_encode( $altered ) ) ) ), 'Different cart reused same key.' );
$other = input( '5f69409d-379d-4ccb-bb30-1cc10ca3f5bf', 12 );
check( is_wp_error( mansu_online_attempt( request( 'POST', '/mansu-pos/v1/attempts', json_encode( $other ) ) ) ) &&
    $GLOBALS['creates'] === 2 && count( $GLOBALS['holds'] ) === 1, 'Parallel option oversold shared parent stock.' );
$other_row = $GLOBALS['wpdb']->attempts[ $other['key'] ];
check( $other_row['state'] === 'needs_review' && $other_row['order_id'] === 202 &&
    wc_get_order( 202 )->has_status( 'pending' ),
    'Failed create cancelled an unverified order or lost the original Woo mapping.' );
$status_request = request( 'GET', '/mansu-pos/v1/attempts/' . $key );
$status_request->set_param( 'key', $key );
$before = $GLOBALS['wpdb']->attempts[ $key ];
$status = mansu_online_status( $status_request );
check( $status['state'] === 'reserved' && $before === $GLOBALS['wpdb']->attempts[ $key ] && $GLOBALS['jobs'] === 1,
    'Read-only status mutated or extended a hold.' );
$pay_req = request( 'POST', '/mansu-pos/v1/attempts/' . $key . '/pay', '{}' );
$pay_req->set_param( 'key', $key );
check( is_wp_error( mansu_online_pay( $pay_req ) ), 'Direct payment bypassed the required Woo cash intent.' );
$intent_req = request( 'POST', '/mansu-pos/v1/attempts/' . $key . '/cash-intent', '{}' );
$intent_req->set_param( 'key', $key );
$intent = mansu_online_cash_intent( $intent_req );
check( ! is_wp_error( $intent ) && $intent['state'] === 'cash_intent' &&
    $intent['cashIntentVerified'] && !$intent['reservationVerified'], 'Original cash-intent acknowledgement missing.' );
check( mansu_online_cash_intent( $intent_req )['cashIntentVerified'], 'Intent replay did not preserve existing Woo order.' );
$intent_cancel_req = request( 'POST', '/mansu-pos/v1/attempts/' . $key . '/cancel', '{}' );
$intent_cancel_req->set_param( 'key', $key );
check( is_wp_error( mansu_online_cancel( $intent_cancel_req ) ), 'Acknowledged cash intent was cancelled.' );
$paid = mansu_online_pay( $pay_req );
check( ! is_wp_error( $paid ) && $paid['state'] === 'paid' && $paid['paymentVerified'] && $paid['paidAt'], 'Native cash completion proof failed.' );
check( $GLOBALS['stock'][10] === 0 && !$GLOBALS['holds'] && $GLOBALS['payments'] === 1,
    'Native stock was not deducted once or hold was not released.' );
$again = mansu_online_pay( $pay_req );
check( $again['paymentVerified'] && $GLOBALS['payments'] === 1 && $GLOBALS['stock'][10] === 0,
    'Paid same-key replay duplicated Woo payment or stock reduction.' );
$GLOBALS['failHoldCount'] = true;
$unproven = mansu_online_status( $status_request );
check( $unproven['state'] === 'needs_review' && !$unproven['paymentVerified'],
    'Failed Woo hold-count read was mistaken for paid/released stock.' );
$GLOBALS['failHoldCount'] = false;
check( mansu_online_status( $status_request )['paymentVerified'], 'Original paid proof did not recover by read-only status.' );
$cancel_req = request( 'POST', '/mansu-pos/v1/attempts/' . $key . '/cancel', '{}' );
$cancel_req->set_param( 'key', $key );
check( is_wp_error( mansu_online_cancel( $cancel_req ) ), 'Paid order was cancelled as unpaid.' );
// A separate synthetic stock receipt for testing unpaid cancellation only.
$GLOBALS['stock'][10] = 1;
$cancel_key = '33f5fcae-de80-46a9-b725-97689a137193';
$unpaid = mansu_online_attempt( request( 'POST', '/mansu-pos/v1/attempts', json_encode( input( $cancel_key, 12 ) ) ) );
check( $unpaid['state'] === 'reserved', 'Unpaid fixture was not reserved.' );
$cancel_req2 = request( 'POST', '/mansu-pos/v1/attempts/' . $cancel_key . '/cancel', '{}' );
$cancel_req2->set_param( 'key', $cancel_key );
$cancelled = mansu_online_cancel( $cancel_req2 );
check( ! is_wp_error( $cancelled ) && $cancelled['state'] === 'cancelled' && $cancelled['cancelledVerified'] &&
    $GLOBALS['stock'][10] === 1, 'Unpaid cancel failed or decremented stock.' );
check( mansu_online_cancel( $cancel_req2 )['cancelledVerified'], 'Cancel replay was not read-only.' );
$expire_key = 'ff19d384-a9e3-4c23-bd9a-33ab087c98a9';
$expiring = mansu_online_attempt( request( 'POST', '/mansu-pos/v1/attempts', json_encode( input( $expire_key ) ) ) );
check( $expiring['state'] === 'reserved', 'Expiry fixture was not reserved.' );
$GLOBALS['holds'][ $expiring['orderId'] ][10]['until'] = time() - 2;
$expire_request = request( 'GET', '/mansu-pos/v1/attempts/' . $expire_key );
$expire_request->set_param( 'key', $expire_key );
check( mansu_online_status( $expire_request )['reservationVerified'] === false, 'Expired hold was treated as valid.' );
mansu_online_expire( 'staging', $expire_key );
check( $GLOBALS['wpdb']->attempts[ $expire_key ]['state'] === 'needs_review' &&
    mansu_online_status( $expire_request )['state'] === 'needs_review' &&
    wc_get_order( $expiring['orderId'] )->has_status( 'pending' ) &&
    isset( $GLOBALS['holds'][ $expiring['orderId'] ] ),
    'Expiry auto-cancelled an order without proof that no POS cash was taken.' );
$tax_key = 'c7c72531-9900-413b-a627-2295f28a0335';
$GLOBALS['tax'] = true;
check( is_wp_error( mansu_online_attempt( request( 'POST', '/mansu-pos/v1/attempts', json_encode( input( $tax_key, 11, 'wholesale' ) ) ) ) ) &&
    !isset( $GLOBALS['wpdb']->attempts[ $tax_key ] ), 'Unverified tax-inclusive quote was accepted.' );
$GLOBALS['tax'] = false;
$wholesale = mansu_online_attempt( request( 'POST', '/mansu-pos/v1/attempts', json_encode( input( $tax_key, 11, 'wholesale' ) ) ) );
check( ! is_wp_error( $wholesale ) && $wholesale['totalCents'] === 7200 &&
    $wholesale['items'][0]['grossCents'] === 7200, 'Agreed wholesale price changed Woo public catalogue or gross.' );
$wholesale_cancel = request( 'POST', '/mansu-pos/v1/attempts/' . $tax_key . '/cancel', '{}' );
$wholesale_cancel->set_param( 'key', $tax_key );
check( mansu_online_cancel( $wholesale_cancel )['cancelledVerified'], 'Wholesale hold was not released.' );
// External stock/status hooks can change an order while its hold still exists.
// Neither a reduced flag nor a partially reduced line can mean a fresh hold.
$touched_key = '869b8154-4025-44a5-816c-b346b5324340';
$touched = mansu_online_attempt( request( 'POST', '/mansu-pos/v1/attempts', json_encode( input( $touched_key ) ) ) );
check( $touched['reservationVerified'], 'Stock-touch fixture was not held.' );
$touched_order = wc_get_order( $touched['orderId'] );
$touched_order->reduced = true;
$touched_status = mansu_online_order_view( mansu_online_row( $touched_key ) );
check( $touched_status['state'] === 'needs_review' && !$touched_status['reservationVerified'] &&
    $touched_status['stockOrCashIntentObserved'], 'Order-level stock flag was mistaken for untouched inventory.' );
$touched_order->reduced = false;
$touched_order->get_item( 1 )->reduce();
$touched_status = mansu_online_order_view( mansu_online_row( $touched_key ) );
check( $touched_status['state'] === 'needs_review' && !$touched_status['reservationVerified'] &&
    $touched_status['stockOrCashIntentObserved'], 'Partial/line stock evidence was mistaken for an untouched hold.' );
$touched_pay = request( 'POST', '/mansu-pos/v1/attempts/' . $touched_key . '/pay', '{}' );
$touched_pay->set_param( 'key', $touched_key );
$touched_cancel = request( 'POST', '/mansu-pos/v1/attempts/' . $touched_key . '/cancel', '{}' );
$touched_cancel->set_param( 'key', $touched_key );
check( is_wp_error( mansu_online_pay( $touched_pay ) ) && is_wp_error( mansu_online_cancel( $touched_cancel ) ) &&
    isset( $GLOBALS['holds'][ $touched['orderId'] ] ) && $GLOBALS['payments'] === 1,
    'External stock movement allowed payment or automatic cancellation.' );
$GLOBALS['wpdb']->attempts[ $touched_key ]['state'] = 'payment_started';
mansu_online_expire( 'staging', $touched_key );
check( $GLOBALS['wpdb']->attempts[ $touched_key ]['state'] === 'needs_review' &&
    $touched_order->has_status( 'pending' ) && isset( $GLOBALS['holds'][ $touched['orderId'] ] ),
    'Expiry automatically cancelled a possible cash custody/payment attempt.' );
// A changed order line or cash-intent marker cannot be auto-cancelled either.
$GLOBALS['stock'][10] = 2;
$edited_key = '28ae4393-55aa-45be-84c3-cb59308d4613';
$edited = mansu_online_attempt( request( 'POST', '/mansu-pos/v1/attempts', json_encode( input( $edited_key, 12 ) ) ) );
check( $edited['reservationVerified'], 'Order-edit fixture was not held.' );
$GLOBALS['products'][12]->sku = 'CHANGED-VARIATION';
$edited_cancel = request( 'POST', '/mansu-pos/v1/attempts/' . $edited_key . '/cancel', '{}' );
$edited_cancel->set_param( 'key', $edited_key );
check( is_wp_error( mansu_online_cancel( $edited_cancel ) ) &&
    wc_get_order( $edited['orderId'] )->has_status( 'pending' ) && isset( $GLOBALS['holds'][ $edited['orderId'] ] ),
    'Edited-order identity was allowed to cancel a held Woo order.' );
$GLOBALS['products'][12]->sku = 'VAR-12';
$GLOBALS['stock'][10] = 3;
$cash_intent_key = 'e2385446-413e-45a9-86ae-d033fe161561';
$cash_intent = mansu_online_attempt( request( 'POST', '/mansu-pos/v1/attempts', json_encode( input( $cash_intent_key, 12 ) ) ) );
check( $cash_intent['reservationVerified'], 'Cash-intent fixture was not held.' );
wc_get_order( $cash_intent['orderId'] )->update_meta_data( '_mansu_online_cash_intent', 'another-actor' );
$cash_intent_view = mansu_online_order_view( mansu_online_row( $cash_intent_key ) );
$cash_intent_cancel = request( 'POST', '/mansu-pos/v1/attempts/' . $cash_intent_key . '/cancel', '{}' );
$cash_intent_cancel->set_param( 'key', $cash_intent_key );
check( !$cash_intent_view['reservationVerified'] && $cash_intent_view['stockOrCashIntentObserved'] &&
    is_wp_error( mansu_online_cancel( $cash_intent_cancel ) ),
    'Existing cash intent was treated as an untouched reservation.' );
echo 'PHP_FLOW_SYNTHETIC_OK ' . $GLOBALS['checks'] . " checks on PHP " . PHP_VERSION . "\n";
}
