<?php
/**
 * Plugin Name: MansutRENDZGH Offline Reservations
 * Description: Separately gated, one-till Woo stock allocations and idempotent offline order import. NOT enabled by installing.
 * Version: 0.1.0
 * Requires Plugins: woocommerce
 * Requires PHP: 8.1
 * Text Domain: mansu-offline
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }

// Install/activation is NOT rollout approval. The site administrator must
// explicitly set this constant only after backed-up, witnessed checkout tests.
function mansu_offline_enabled() {
    return defined( 'MANSU_OFFLINE_RESERVATIONS_ENABLED' ) && MANSU_OFFLINE_RESERVATIONS_ENABLED === true;
}
function mansu_offline_tables() {
    global $wpdb;
    return array( $wpdb->prefix . 'mansu_offline_allocations', $wpdb->prefix . 'mansu_offline_events' );
}
function mansu_offline_install() {
    global $wpdb;
    list( $alloc, $events ) = mansu_offline_tables();
    $charset = $wpdb->get_charset_collate();
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    dbDelta( "CREATE TABLE $alloc (
        stock_key varchar(64) NOT NULL,
        device_id char(36) NOT NULL,
        product_id bigint(20) unsigned NOT NULL,
        variation_id bigint(20) unsigned NOT NULL,
        remaining bigint(20) NOT NULL,
        revision bigint(20) NOT NULL,
        expires_at datetime NOT NULL,
        created_at datetime NOT NULL,
        PRIMARY KEY  (stock_key),
        KEY device_id (device_id)
    ) $charset ENGINE=InnoDB;" );
    dbDelta( "CREATE TABLE $events (
        id char(36) NOT NULL,
        device_id char(36) NOT NULL,
        kind varchar(12) NOT NULL,
        fingerprint char(64) NOT NULL,
        sale_id char(36) NOT NULL,
        order_id bigint(20) unsigned NOT NULL DEFAULT 0,
        refund_id bigint(20) unsigned NOT NULL DEFAULT 0,
        amount bigint(20) NOT NULL DEFAULT 0,
        state varchar(16) NOT NULL,
        payload_json longtext NOT NULL,
        created_at datetime NOT NULL,
        PRIMARY KEY  (id),
        KEY sale_id (sale_id)
    ) $charset ENGINE=InnoDB;" );
}
register_activation_hook( __FILE__, 'mansu_offline_install' );

function mansu_offline_error( $message, $status = 409 ) {
    return new WP_Error( 'mansu_offline_review', $message, array( 'status' => $status ) );
}
function mansu_offline_uuid( $value ) {
    return is_string( $value ) && preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D', $value );
}
function mansu_offline_int( $value, $minimum = 0, $maximum = 1000000 ) {
    return is_int( $value ) && $value >= $minimum && $value <= $maximum;
}
function mansu_offline_ready() {
    global $wpdb;
    if ( ! mansu_offline_enabled() || ! function_exists( 'wc_get_product' ) || ! function_exists( 'wc_get_held_stock_quantity' ) ||
         ! function_exists( 'wc_tax_enabled' ) || wc_tax_enabled() || get_option( 'woocommerce_manage_stock' ) !== 'yes' ||
         get_option( 'woocommerce_schema_version', 0 ) < 430 ||
         ! apply_filters( 'woocommerce_hold_stock_for_checkout', true ) || get_woocommerce_currency() !== 'GHS' ) {
        // Tax-inclusive order calculation and stock reservations must be
        // witnessed before extending this intentionally cash-only/no-tax path.
        return false;
    }
    list( $alloc, $events ) = mansu_offline_tables();
    // SQLite, MyISAM, a missing Woo checkout-hold table or an altered HPOS
    // storage engine would break the all-or-nothing stock/order transaction.
    $required = array( $alloc, $events, $wpdb->postmeta, $wpdb->posts, $wpdb->wc_reserved_stock,
        $wpdb->prefix . 'wc_product_meta_lookup', $wpdb->prefix . 'woocommerce_order_items', $wpdb->prefix . 'woocommerce_order_itemmeta' );
    foreach ( $required as $table ) {
        $engine = $wpdb->get_var( $wpdb->prepare( 'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s', $table ) );
        if ( strtoupper( (string) $engine ) !== 'INNODB' ) { return false; }
    }
    if ( class_exists( \Automattic\WooCommerce\Utilities\OrderUtil::class ) &&
         \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled() ) {
        foreach ( array( $wpdb->prefix . 'wc_orders', $wpdb->prefix . 'wc_orders_meta', $wpdb->prefix . 'wc_order_addresses',
                        $wpdb->prefix . 'wc_order_operational_data' ) as $table ) {
            $engine = $wpdb->get_var( $wpdb->prepare( 'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s', $table ) );
            if ( strtoupper( (string) $engine ) !== 'INNODB' ) { return false; }
        }
    }
    return true;
}
function mansu_offline_permission() { return current_user_can( 'manage_woocommerce' ); }
function mansu_offline_routes() {
    register_rest_route( 'mansu-pos/v1', '/status', array( 'methods' => 'GET', 'callback' => 'mansu_offline_status', 'permission_callback' => 'mansu_offline_permission' ) );
    register_rest_route( 'mansu-pos/v1', '/allocate', array( 'methods' => 'POST', 'callback' => 'mansu_offline_allocate', 'permission_callback' => 'mansu_offline_permission' ) );
    register_rest_route( 'mansu-pos/v1', '/sync', array( 'methods' => 'POST', 'callback' => 'mansu_offline_sync', 'permission_callback' => 'mansu_offline_permission' ) );
}
add_action( 'rest_api_init', 'mansu_offline_routes' );

// An offline order already consumed its units at allocation time. Never let
// Woo decrease those same units on payment OR restore them on cancellation;
// returns explicitly go back to the reservation, not to website stock.
function mansu_offline_skip_order_stock( $allowed, $order ) {
    if ( $order instanceof WC_Order && $order->get_meta( '_mansu_offline_sale_id', true ) ) { return false; }
    return $allowed;
}
add_filter( 'woocommerce_can_reduce_order_stock', 'mansu_offline_skip_order_stock', 10, 2 );
add_filter( 'woocommerce_can_restore_order_stock', 'mansu_offline_skip_order_stock', 10, 2 );

function mansu_offline_grant( $row ) {
    return array( 'stockKey' => $row['stock_key'], 'productId' => (int) $row['product_id'],
        'variationId' => (int) $row['variation_id'], 'remaining' => (int) $row['remaining'],
        'revision' => (int) $row['revision'], 'expiresAt' => gmdate( 'Y-m-d\TH:i:s\Z', strtotime( $row['expires_at'] . ' UTC' ) ) );
}
function mansu_offline_status( $request ) {
    global $wpdb;
    $device = $request->get_param( 'device_id' );
    if ( ! mansu_offline_uuid( $device ) ) { return mansu_offline_error( 'A registered device ID is required.', 400 ); }
    list( $alloc ) = mansu_offline_tables();
    if ( ! mansu_offline_ready() ) { return mansu_offline_error( 'Stock reservations are not enabled or transactional Woo storage is unavailable.', 503 ); }
    $rows = $wpdb->get_results( $wpdb->prepare( "SELECT * FROM $alloc WHERE device_id=%s ORDER BY stock_key", $device ), ARRAY_A );
    $grants = array_map( 'mansu_offline_grant', $rows );
    $expiry = $rows ? min( array_column( $rows, 'expires_at' ) ) : gmdate( 'Y-m-d H:i:s' );
    return array( 'deviceId' => $device, 'enabled' => true, 'enforced' => true,
        'leaseExpiresAt' => gmdate( 'Y-m-d\TH:i:s\Z', strtotime( $expiry . ' UTC' ) ), 'grants' => $grants );
}
function mansu_offline_product( $product_id, $variation_id ) {
    $parent = wc_get_product( $product_id );
    $product = $variation_id ? wc_get_product( $variation_id ) : $parent;
    if ( ! $parent || ! $product || ! in_array( $parent->get_type(), array( 'simple', 'variable' ), true ) ||
         $parent->get_status() !== 'publish' || ( $variation_id && ( ! $product->is_type( 'variation' ) || $product->get_parent_id() !== $product_id ) ) ||
         ( ! $variation_id && ! $parent->is_type( 'simple' ) && ! $parent->managing_stock() ) ||
         ! $product->managing_stock() || $product->backorders_allowed() || $parent->backorders_allowed() ||
         ! $product->get_stock_managed_by_id() ) { return false; }
    $stock_id = $product->get_stock_managed_by_id();
    if ( $stock_id !== $product_id && $stock_id !== $variation_id ) { return false; }
    return array( 'product' => $product, 'stock_id' => $stock_id,
        'stock_key' => $product_id . ':' . ( $stock_id === $product_id ? '0' : $variation_id ),
        'variation_id' => $stock_id === $product_id ? 0 : $variation_id );
}
function mansu_offline_allocate( $request ) {
    global $wpdb;
    if ( ! mansu_offline_ready() ) { return mansu_offline_error( 'Reservation gate or Woo transactional storage is not ready.', 503 ); }
    $v = $request->get_json_params();
    if ( ! is_array( $v ) || ! mansu_offline_uuid( $v['idempotencyKey'] ?? null ) || ! mansu_offline_uuid( $v['deviceId'] ?? null ) ||
         ! mansu_offline_int( $v['productId'] ?? null, 1, PHP_INT_MAX ) ||
         ! mansu_offline_int( $v['variationId'] ?? null, 0, PHP_INT_MAX ) ||
         ! mansu_offline_int( $v['quantity'] ?? null, 1, 1000 ) ) { return mansu_offline_error( 'Invalid allocation request.', 400 ); }
    $identity = mansu_offline_product( $v['productId'], $v['variationId'] );
    if ( ! $identity ) { return mansu_offline_error( 'Only a published, managed-stock product or exact variation without backorders may be allocated.' ); }
    $product = $identity['product'];
    $key = $identity['stock_key'];
    list( $alloc, $events ) = mansu_offline_tables();
    $fp = hash( 'sha256', $request->get_body() );
    $wpdb->query( 'START TRANSACTION' );
    try {
        $existing = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM $events WHERE id=%s FOR UPDATE", $v['idempotencyKey'] ), ARRAY_A );
        $prior = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM $alloc WHERE stock_key=%s FOR UPDATE", $key ), ARRAY_A );
        if ( $existing ) {
            if ( $existing['kind'] !== 'allocation' || $existing['fingerprint'] !== $fp || $existing['device_id'] !== $v['deviceId'] ||
                 ! $prior || $prior['device_id'] !== $v['deviceId'] ) { throw new Exception( 'Allocation key conflicts with a different reservation.' ); }
            $wpdb->query( 'COMMIT' );
            return array( 'deviceId' => $v['deviceId'], 'stockKey' => $key, 'grant' => mansu_offline_grant( $prior ) );
        }
        if ( $prior && $prior['device_id'] !== $v['deviceId'] ) { throw new Exception( 'That stock pool belongs to another till.' ); }
        $wpdb->insert( $events, array( 'id' => $v['idempotencyKey'], 'device_id' => $v['deviceId'], 'kind' => 'allocation',
            'fingerprint' => $fp, 'sale_id' => $v['idempotencyKey'], 'state' => 'creating', 'payload_json' => wp_json_encode( $v ),
            'created_at' => current_time( 'mysql', true ) ) );
        if ( $wpdb->last_error ) { throw new Exception( 'Could not claim this allocation ID.' ); }
        // Serialize against Woo's _stock row and reject missing, fractional or
        // insufficient public stock. An offline grant is NEVER seeded from a
        // stale REST snapshot or a CSV/PDF count.
        $raw = $wpdb->get_var( $wpdb->prepare( "SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id=%d AND meta_key='_stock' FOR UPDATE", $identity['stock_id'] ) );
        // Woo also holds units for pending online checkouts in a separate
        // table. Locking _stock serializes this check against Woo's normal
        // checkout hold. Ignoring those holds would allocate an already
        // promised last unit. Late gateway payments/admin edits still need a
        // witnessed concurrency policy before the selling gate can open.
        $held = wc_get_held_stock_quantity( $product );
        if ( ! is_string( $raw ) || ! ctype_digit( $raw ) || ! is_numeric( $held ) ||
             ! is_finite( (float) $held ) || (float) $held < 0 || floor( (float) $held ) !== (float) $held ||
             (int) $raw - (int) $held < $v['quantity'] ) {
            throw new Exception( 'Insufficient unheld website stock. No reservation was created.' );
        }
        $after = wc_update_product_stock( $product, $v['quantity'], 'decrease' );
        // Woo's data store returns a *predicted* balance even when its SQL
        // update affects no rows. Re-read the actual row under the same lock.
        $actual = $wpdb->get_var( $wpdb->prepare( "SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id=%d AND meta_key='_stock' FOR UPDATE", $identity['stock_id'] ) );
        if ( $after === false || is_wp_error( $after ) || ! is_string( $actual ) || ! ctype_digit( $actual ) ||
             (int) $after !== (int) $raw - $v['quantity'] || (int) $actual !== (int) $raw - $v['quantity'] ) {
            throw new Exception( 'Woo did not persist the exact stock reduction.' );
        }
        $expiry = gmdate( 'Y-m-d H:i:s', time() + DAY_IN_SECONDS );
        if ( $prior ) {
            if ( strtotime( $prior['expires_at'] . ' UTC' ) <= time() ) { throw new Exception( 'The old lease expired. Reconcile this till before allocating more.' ); }
            $revision = (int) $prior['revision'] + 1;
            $remaining = (int) $prior['remaining'] + $v['quantity'];
            $wpdb->update( $alloc, array( 'remaining' => $remaining, 'revision' => $revision, 'expires_at' => $expiry ), array( 'stock_key' => $key ) );
        } else {
            $revision = 1; $remaining = $v['quantity'];
            $wpdb->insert( $alloc, array( 'stock_key' => $key, 'device_id' => $v['deviceId'],
                'product_id' => $v['productId'], 'variation_id' => $identity['variation_id'],
                'remaining' => $remaining, 'revision' => $revision, 'created_at' => current_time( 'mysql', true ), 'expires_at' => $expiry ) );
        }
        if ( $wpdb->last_error ) { throw new Exception( 'The allocation ledger could not be saved.' ); }
        $wpdb->update( $events, array( 'state' => 'acked' ), array( 'id' => $v['idempotencyKey'] ) );
        if ( $wpdb->last_error ) { throw new Exception( 'The allocation acknowledgement could not be saved.' ); }
        $wpdb->query( 'COMMIT' );
        return array( 'deviceId' => $v['deviceId'], 'stockKey' => $key,
            'grant' => array( 'stockKey' => $key, 'productId' => $v['productId'], 'variationId' => $identity['variation_id'],
                'remaining' => $remaining, 'revision' => $revision, 'expiresAt' => gmdate( 'Y-m-d\TH:i:s\Z', strtotime( $expiry . ' UTC' ) ) ) );
    } catch ( Throwable $e ) {
        $wpdb->query( 'ROLLBACK' );
        return mansu_offline_error( $e->getMessage() );
    }
}
function mansu_offline_ack( $row ) {
    return array( 'id' => $row['id'], 'fingerprint' => $row['fingerprint'], 'orderId' => (int) $row['order_id'],
        'refundId' => (int) $row['refund_id'] ?: null, 'amount' => (int) $row['amount'] );
}
function mansu_offline_sync( $request ) {
    global $wpdb;
    if ( ! mansu_offline_ready() ) { return mansu_offline_error( 'Reservations disabled; no order or refund was created.', 503 ); }
    $raw = $request->get_body(); $event = json_decode( $raw, true );
    if ( ! is_array( $event ) || ! mansu_offline_uuid( $event['id'] ?? null ) || ! mansu_offline_uuid( $event['deviceId'] ?? null ) ||
         ! in_array( $event['kind'] ?? '', array( 'sale', 'return' ), true ) || strlen( $raw ) > 65536 ) {
        return mansu_offline_error( 'Invalid offline event.', 400 );
    }
    $fp = hash( 'sha256', $raw );
    list( $alloc, $events ) = mansu_offline_tables();
    $wpdb->query( 'START TRANSACTION' );
    try {
        $saved = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM $events WHERE id=%s FOR UPDATE", $event['id'] ), ARRAY_A );
        if ( $saved ) {
            if ( $saved['fingerprint'] !== $fp || $saved['device_id'] !== $event['deviceId'] || $saved['kind'] !== $event['kind'] ) {
                throw new Exception( 'This event ID already belongs to different contents.' );
            }
            $wpdb->query( 'COMMIT' );
            if ( $saved['state'] === 'created' && $saved['kind'] === 'sale' ) { return mansu_offline_finalize_sale( $saved ); }
            if ( $saved['state'] !== 'acked' ) { return mansu_offline_error( 'Existing event needs manual reconciliation.', 503 ); }
            return mansu_offline_ack( $saved );
        }
        if ( $event['kind'] === 'sale' ) {
            $result = mansu_offline_create_sale( $event, $fp, $alloc, $events );
        } else {
            $result = mansu_offline_create_return( $event, $fp, $alloc, $events );
        }
        $wpdb->query( 'COMMIT' );
        return $event['kind'] === 'sale' ? mansu_offline_finalize_sale( $result ) : mansu_offline_ack( $result );
    } catch ( Throwable $e ) {
        $wpdb->query( 'ROLLBACK' );
        return mansu_offline_error( $e->getMessage() );
    }
}
function mansu_offline_create_sale( $v, $fp, $alloc, $events ) {
    global $wpdb;
    if ( ! mansu_offline_uuid( $v['cashierId'] ?? null ) || ! in_array( $v['saleType'] ?? '', array( 'retail','wholesale' ), true ) ||
         ! in_array( $v['paymentMethod'] ?? '', array( 'cash','momo' ), true ) ||
         ( $v['paymentMethod'] === 'cash' ? ( $v['paymentStatus'] ?? '' ) !== 'cash_received' : ( $v['paymentStatus'] ?? '' ) !== 'unverified' ) ||
         ! mansu_offline_int( $v['total'] ?? null, 1, 1000000000 ) || ! is_array( $v['items'] ?? null ) ||
         count( $v['items'] ) < 1 || count( $v['items'] ) > 100 || ! is_array( $v['grantRevisions'] ?? null ) ||
         ! is_string( $v['createdAt'] ?? null ) || ! strtotime( $v['createdAt'] ) ) { throw new Exception( 'Invalid offline sale.' ); }
    $spend = array(); $order_lines = array(); $sum = 0;
    foreach ( $v['items'] as $line ) {
        if ( ! mansu_offline_int( $line['productId'] ?? null, 1, PHP_INT_MAX ) || ! mansu_offline_int( $line['variationId'] ?? null, 0, PHP_INT_MAX ) ||
             ! mansu_offline_int( $line['quantity'] ?? null, 1, 999 ) || ! mansu_offline_int( $line['price'] ?? null, 1, 100000000 ) ) {
            throw new Exception( 'Invalid offline line.' );
        }
        $identity = mansu_offline_product( $line['productId'], $line['variationId'] );
        if ( ! $identity || $identity['stock_key'] !== ( $line['stockKey'] ?? '' ) ) {
            throw new Exception( 'Product identity changed. Owner must reconcile without duplicating this sale.' );
        }
        // The global Woo tax calculation gate is OFF (checked by ready()).
        // A product can still have tax_status=taxable even when Woo taxes are
        // disabled; do not incorrectly strand an already collected cash sale.
        $current_price = (int) round( (float) $identity['product']->get_price() * 100 );
        if ( $v['saleType'] === 'retail' && $current_price !== $line['price'] ) { throw new Exception( 'Retail price changed after offline checkout. Owner review required.' ); }
        $unit = $v['saleType'] === 'wholesale' ? ( $line['agreedUnitPrice'] ?? 0 ) : $line['price'];
        if ( ! mansu_offline_int( $unit, 1, 100000000 ) ) { throw new Exception( 'Wholesale approval or unit amount is missing.' ); }
        $sum += $unit * $line['quantity'];
        $key = $identity['stock_key'];
        $spend[ $key ] = ( $spend[ $key ] ?? 0 ) + $line['quantity'];
        $order_lines[] = array( 'product' => $identity['product'], 'qty' => $line['quantity'], 'unit' => $unit );
    }
    if ( $sum !== $v['total'] || ( $v['paymentMethod'] === 'cash' && ( $v['tendered'] ?? 0 ) < $sum ) ) {
        throw new Exception( 'Collected amount does not match the validated lines.' );
    }
    foreach ( $spend as $key => $qty ) {
        $grant = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM $alloc WHERE stock_key=%s FOR UPDATE", $key ), ARRAY_A );
        if ( ! $grant || $grant['device_id'] !== $v['deviceId'] || (int) $grant['revision'] < ( $v['grantRevisions'][ $key ] ?? 0 ) ||
             ( $v['grantRevisions'][ $key ] ?? 0 ) < 1 || (int) $grant['remaining'] < $qty ||
             strtotime( $v['createdAt'] ) > strtotime( $grant['expires_at'] . ' UTC' ) ||
             strtotime( $v['createdAt'] ) < strtotime( $grant['created_at'] . ' UTC' ) - 300 ) {
            throw new Exception( 'The reserved stock does not cover this offline sale. Do not create a new event ID.' );
        }
        $updated = $wpdb->query( $wpdb->prepare( "UPDATE $alloc SET remaining=remaining-%d WHERE stock_key=%s AND remaining >= %d", $qty, $key, $qty ) );
        if ( $updated !== 1 ) { throw new Exception( 'Allocation changed during the sale.' ); }
    }
    // Woo order creation and the unique event ID share one InnoDB transaction.
    // If a hook writes to a nontransactional external service, approval must
    // stay OFF until those side effects are separately accepted on the site.
    $wpdb->insert( $events, array( 'id' => $v['id'], 'device_id' => $v['deviceId'], 'kind' => 'sale',
        'fingerprint' => $fp, 'sale_id' => $v['id'], 'state' => 'creating', 'payload_json' => wp_json_encode( $v ),
        'created_at' => current_time( 'mysql', true ) ) );
    if ( $wpdb->last_error ) { throw new Exception( 'Could not claim this sale ID.' ); }
    $order = wc_create_order( array( 'status' => 'pending', 'created_via' => 'mansu-offline' ) );
    if ( is_wp_error( $order ) || ! $order ) { throw new Exception( 'Woo did not create an order.' ); }
    $order->set_currency( 'GHS' );
    $order->set_payment_method( $v['paymentMethod'] === 'cash' ? 'pos_cash' : 'pos_momo_unverified' );
    $order->set_payment_method_title( $v['paymentMethod'] === 'cash' ? 'Cash collected at offline till' : 'MoMo reference (NOT VERIFIED)' );
    if ( $v['saleType'] === 'wholesale' && is_string( $v['buyerName'] ?? null ) ) { $order->set_billing_first_name( $v['buyerName'] ); }
    $order->update_meta_data( '_mansu_offline_sale_id', $v['id'] );
    $order->update_meta_data( '_mansu_offline_device_id', $v['deviceId'] );
    $order->update_meta_data( '_mansu_pos_key', $v['id'] );
    $order->update_meta_data( '_mansu_offline_payment_status', $v['paymentStatus'] );
    $order->update_meta_data( '_mansu_offline_cashier', $v['cashierId'] );
    if ( $v['saleType'] === 'wholesale' ) { $order->update_meta_data( '_mansu_offline_approver', $v['approvedById'] ?? '' ); }
    foreach ( $order_lines as $line ) {
        $gross = $line['qty'] * $line['unit'];
        $order->add_product( $line['product'], $line['qty'], array( 'subtotal' => number_format( $gross / 100, 2, '.', '' ),
            'total' => number_format( $gross / 100, 2, '.', '' ) ) );
    }
    $order->calculate_totals( false );
    if ( (int) round( (float) $order->get_total() * 100 ) !== $v['total'] ) { throw new Exception( 'Woo changed the collected total. Order rolled back.' ); }
    $order->save();
    $wpdb->update( $events, array( 'state' => 'created', 'order_id' => $order->get_id(), 'amount' => $v['total'] ), array( 'id' => $v['id'] ) );
    if ( $wpdb->last_error ) { throw new Exception( 'Woo order mapping could not be saved.' ); }
    return $wpdb->get_row( $wpdb->prepare( "SELECT * FROM $events WHERE id=%s", $v['id'] ), ARRAY_A );
}
function mansu_offline_finalize_sale( $row ) {
    global $wpdb;
    list( , $events ) = mansu_offline_tables();
    $v = json_decode( $row['payload_json'], true );
    $order = wc_get_order( (int) $row['order_id'] );
    if ( ! $order || $order->get_meta( '_mansu_offline_sale_id', true ) !== $row['id'] ||
         $order->get_meta( '_mansu_offline_device_id', true ) !== $row['device_id'] ) {
        return mansu_offline_error( 'The Woo order identity needs owner review.' );
    }
    if ( $v['paymentMethod'] === 'cash' ) {
        if ( ! in_array( $order->get_status(), array( 'pending', 'completed' ), true ) ) { return mansu_offline_error( 'The offline cash order changed status.' ); }
        if ( $order->get_status() === 'pending' ) {
            $order->set_date_paid( time() );
            $order->set_status( 'completed', 'Offline till recorded cash. Stock was reserved before the sale.' );
            $order->save();
        }
        if ( ! $order->get_date_paid() || $order->get_status() !== 'completed' ) { return mansu_offline_error( 'Woo did not confirm cash payment.', 503 ); }
    } elseif ( $order->get_status() !== 'pending' || $order->get_date_paid() ) {
        return mansu_offline_error( 'Unverified MoMo must remain unpaid in Woo.' );
    }
    $wpdb->update( $events, array( 'state' => 'acked' ), array( 'id' => $row['id'], 'state' => 'created' ) );
    return mansu_offline_ack( $wpdb->get_row( $wpdb->prepare( "SELECT * FROM $events WHERE id=%s", $row['id'] ), ARRAY_A ) );
}
function mansu_offline_create_return( $v, $fp, $alloc, $events ) {
    global $wpdb;
    if ( ! mansu_offline_uuid( $v['saleId'] ?? null ) || ! mansu_offline_uuid( $v['actorId'] ?? null ) ||
         ( $v['cashRefunded'] ?? false ) !== true || ! mansu_offline_int( $v['amount'] ?? null, 1, 1000000000 ) ||
         ! is_array( $v['items'] ?? null ) || ! count( $v['items'] ) || count( $v['items'] ) > 100 ) {
        throw new Exception( 'Invalid return.' );
    }
    $sale = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM $events WHERE id=%s AND kind='sale' AND state='acked' FOR UPDATE", $v['saleId'] ), ARRAY_A );
    if ( ! $sale || $sale['device_id'] !== $v['deviceId'] ) { throw new Exception( 'Original sale has not been confirmed by Woo.' ); }
    $order = wc_get_order( (int) $sale['order_id'] );
    if ( ! $order || $order->get_meta( '_mansu_offline_sale_id', true ) !== $v['saleId'] || ! $order->get_date_paid() ) {
        throw new Exception( 'Original Woo cash order needs owner review.' );
    }
    $original = json_decode( $sale['payload_json'], true );
    $prior = $wpdb->get_results( $wpdb->prepare( "SELECT payload_json FROM $events WHERE sale_id=%s AND kind='return' AND state='acked'", $v['saleId'] ), ARRAY_A );
    $returned = array(); $prior_amount = 0;
    foreach ( $prior as $record ) {
        $completed = json_decode( $record['payload_json'], true );
        if ( ! is_array( $completed ) || ! mansu_offline_int( $completed['amount'] ?? null, 1, 1000000000 ) ) {
            throw new Exception( 'Existing return ledger needs owner review.' );
        }
        $prior_amount += $completed['amount'];
        foreach ( $completed['items'] as $item ) {
            $key = $item['productId'] . ':' . $item['variationId']; $returned[ $key ] = ( $returned[ $key ] ?? 0 ) + $item['quantity'];
        }
    }
    // A refund from another Woo channel cannot be silently refunded twice.
    if ( (int) round( (float) $order->get_total_refunded() * 100 ) !== $prior_amount ) {
        throw new Exception( 'Woo refunds differ from the offline ledger. Owner reconciliation is required.' );
    }
    $refund_lines = array(); $amount = 0; $stock = array();
    foreach ( $v['items'] as $item ) {
        $key = ( $item['productId'] ?? '' ) . ':' . ( $item['variationId'] ?? '' );
        $line = null;
        foreach ( $original['items'] as $candidate ) {
            if ( $candidate['productId'] . ':' . $candidate['variationId'] === $key ) { $line = $candidate; break; }
        }
        if ( ! $line || ! mansu_offline_int( $item['quantity'] ?? null, 1, 999 ) ||
             ( $returned[ $key ] ?? 0 ) + $item['quantity'] > $line['quantity'] || $item['stockKey'] !== $line['stockKey'] ||
             $item['amount'] !== $item['quantity'] * ( $line['agreedUnitPrice'] ?? $line['price'] ) ) {
            throw new Exception( 'Return exceeds the original order or changes its amount.' );
        }
        $returned[ $key ] += $item['quantity']; $amount += $item['amount'];
        $stock[ $item['stockKey'] ] = ( $stock[ $item['stockKey'] ] ?? 0 ) + $item['quantity'];
        foreach ( $order->get_items( 'line_item' ) as $order_item ) {
            if ( $order_item->get_product_id() === $item['productId'] && (int) $order_item->get_variation_id() === $item['variationId'] ) {
                $refund_lines[ $order_item->get_id() ] = array( 'qty' => $item['quantity'],
                    'refund_total' => number_format( $item['amount'] / 100, 2, '.', '' ) ); break;
            }
        }
    }
    if ( $amount !== $v['amount'] || count( $refund_lines ) !== count( $v['items'] ) ) { throw new Exception( 'Return and Woo order lines disagree.' ); }
    foreach ( $stock as $key => $qty ) {
        $grant = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM $alloc WHERE stock_key=%s FOR UPDATE", $key ), ARRAY_A );
        if ( ! $grant || $grant['device_id'] !== $v['deviceId'] ) { throw new Exception( 'Returned stock has no original reservation.' ); }
        $wpdb->query( $wpdb->prepare( "UPDATE $alloc SET remaining=remaining+%d WHERE stock_key=%s", $qty, $key ) );
    }
    $wpdb->insert( $events, array( 'id' => $v['id'], 'device_id' => $v['deviceId'], 'kind' => 'return',
        'fingerprint' => $fp, 'sale_id' => $v['saleId'], 'order_id' => $order->get_id(),
        'state' => 'creating', 'payload_json' => wp_json_encode( $v ), 'created_at' => current_time( 'mysql', true ) ) );
    if ( $wpdb->last_error ) { throw new Exception( 'Could not claim this return ID.' ); }
    $refund = wc_create_refund( array( 'amount' => number_format( $amount / 100, 2, '.', '' ), 'reason' => $v['reason'],
        'order_id' => $order->get_id(), 'line_items' => $refund_lines, 'refund_payment' => false, 'restock_items' => false ) );
    if ( is_wp_error( $refund ) || ! $refund || ! $refund->get_id() ) { throw new Exception( 'Woo refund could not be created. No stock was replenished.' ); }
    $wpdb->update( $events, array( 'state' => 'acked', 'refund_id' => $refund->get_id(), 'amount' => $amount ), array( 'id' => $v['id'] ) );
    if ( $wpdb->last_error ) { throw new Exception( 'Woo refund mapping could not be saved.' ); }
    return $wpdb->get_row( $wpdb->prepare( "SELECT * FROM $events WHERE id=%s", $v['id'] ), ARRAY_A );
}
