<?php
/**
 * Plugin Name: Mansu Online POS Bridge
 * Description: Disabled-by-default managed-stock bridge; live activation requires separate owner approval and installed-site verification.
 * Version: 0.2.0-dev
 * Requires Plugins: woocommerce
 * Requires PHP: 8.1
 */

defined( 'ABSPATH' ) || exit;

// Production activation is a distinct, opt-in release decision. This source
// change does NOT approve a live installation or any production write.
const MANSU_ONLINE_HOLD_MINUTES = 10; // Synthetic local fixture, not approved business policy.
const MANSU_ONLINE_CASH_MARGIN_SECONDS = 90;
const MANSU_ONLINE_PAYSTACK_ENTRY_MARGIN_SECONDS = 90; // Safety margin for upstream gateway verification; still recheck before payment completion.
const MANSU_ONLINE_PINNED_WOO = '11.0.1'; // Inspected source, NOT installed-site compatibility evidence.

function mansu_online_uuid( $value ) {
    return is_string( $value ) && (bool) preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D', $value );
}
function mansu_online_enabled() {
    if ( ! defined( 'MANSU_ONLINE_BRIDGE_ENABLED' ) || MANSU_ONLINE_BRIDGE_ENABLED !== true ||
         ! function_exists( 'wp_get_environment_type' ) ||
         ! defined( 'MANSU_ONLINE_BRIDGE_SERVICE' ) ||
         ! defined( 'MANSU_ONLINE_BRIDGE_LEDGER_ID' ) || ! mansu_online_uuid( MANSU_ONLINE_BRIDGE_LEDGER_ID ) ||
         ! defined( 'MANSU_ONLINE_BRIDGE_SITE_ID' ) || ! mansu_online_uuid( MANSU_ONLINE_BRIDGE_SITE_ID ) ) {
        return false;
    }
    $environment = wp_get_environment_type();
    if ( $environment === 'local' ) {
        return MANSU_ONLINE_BRIDGE_SERVICE === 'staging';
    }
    // Separate release decision: even a copied ENABLED=true does not authorise
    // a production site unless service, host, TLS, reference and UUIDs agree.
    return $environment === 'production' && MANSU_ONLINE_BRIDGE_SERVICE === 'live-trading' &&
        defined( 'MANSU_ONLINE_BRIDGE_LIVE_ACCEPTED' ) && MANSU_ONLINE_BRIDGE_LIVE_ACCEPTED === true &&
        defined( 'MANSU_ONLINE_BRIDGE_LIVE_ACCEPTANCE_REFERENCE' ) &&
        is_string( MANSU_ONLINE_BRIDGE_LIVE_ACCEPTANCE_REFERENCE ) &&
        strlen( trim( MANSU_ONLINE_BRIDGE_LIVE_ACCEPTANCE_REFERENCE ) ) >= 12 &&
        defined( 'MANSU_ONLINE_BRIDGE_SITE_HOST' ) &&
        in_array( MANSU_ONLINE_BRIDGE_SITE_HOST, array( 'mansutrendzgh.com', 'www.mansutrendzgh.com' ), true ) &&
        function_exists( 'home_url' ) &&
        wp_parse_url( home_url(), PHP_URL_HOST ) === MANSU_ONLINE_BRIDGE_SITE_HOST &&
        is_ssl();
}
function mansu_online_table() {
    global $wpdb;
    return $wpdb->prefix . 'mansu_online_attempts';
}
function mansu_online_install() {
    if ( ! mansu_online_enabled() ) { return; }
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $table = mansu_online_table();
    // Claim must commit before Woo order creation; engine is checked at every
    // request. No Woo stock tables are written by this extension.
    dbDelta( "CREATE TABLE $table (
        service varchar(32) NOT NULL,
        attempt_key char(36) NOT NULL,
        ledger_id char(36) NOT NULL,
        fingerprint char(64) NOT NULL,
        payload_hash char(64) NOT NULL,
        items_json longtext NOT NULL,
        context_json longtext NOT NULL,
        state varchar(24) NOT NULL,
        order_id bigint(20) unsigned NULL DEFAULT NULL,
        total_cents bigint(20) unsigned NOT NULL DEFAULT 0,
        tax_cents bigint(20) unsigned NOT NULL DEFAULT 0,
        created_at datetime NOT NULL,
        updated_at datetime NOT NULL,
        PRIMARY KEY  (service,attempt_key),
        UNIQUE KEY order_id (order_id),
        KEY state_updated (state,updated_at)
    ) {$wpdb->get_charset_collate()} ENGINE=InnoDB;" );
}
register_activation_hook( __FILE__, 'mansu_online_install' );

function mansu_online_error( $code, $message, $status = 409 ) {
    return new WP_Error( $code, $message, array( 'status' => $status ) );
}
function mansu_online_int( $value, $min, $max ) {
    return is_int( $value ) && $value >= $min && $value <= $max;
}
function mansu_online_money( $value ) {
    $text = (string) $value;
    if ( ! preg_match( '/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,2})?$/D', $text ) ) { return -1; }
    $parts = explode( '.', $text );
    return (int) $parts[0] * 100 + (int) str_pad( $parts[1] ?? '0', 2, '0' );
}
function mansu_online_permission( $request ) {
    if ( ! mansu_online_enabled() || ! current_user_can( 'mansu_online_bridge' ) ||
         ! defined( 'MANSU_ONLINE_BRIDGE_SECRET' ) || ! is_string( MANSU_ONLINE_BRIDGE_SECRET ) ||
         strlen( MANSU_ONLINE_BRIDGE_SECRET ) < 32 ) {
        return mansu_online_error( 'mansu_disabled', 'The dedicated local service is not authorised.', 403 );
    }
    // WordPress authenticates the separate service account's Application
    // Password; the custom capability is NEVER granted automatically.
    if ( ! is_ssl() && ! in_array( $_SERVER['REMOTE_ADDR'] ?? '', array( '127.0.0.1', '::1' ), true ) ) {
        return mansu_online_error( 'mansu_tls', 'HTTPS or local loopback is required.', 403 );
    }
    $timestamp = $request->get_header( 'x-mansu-bridge-timestamp' );
    $signature = $request->get_header( 'x-mansu-bridge-signature' );
    $body = $request->get_body();
    if ( ! is_string( $timestamp ) || ! preg_match( '/^[0-9]{10}$/D', $timestamp ) ||
         abs( time() - (int) $timestamp ) > 60 || ! is_string( $signature ) ||
         ! preg_match( '/^[a-f0-9]{64}$/D', $signature ) || strlen( $body ) > 16384 ) {
        return mansu_online_error( 'mansu_signature', 'A recent signed service request is required.', 403 );
    }
    $message = $timestamp . "\n" . $request->get_method() . "\n" . $request->get_route() . "\n" . hash( 'sha256', $body );
    if ( ! hash_equals( hash_hmac( 'sha256', $message, MANSU_ONLINE_BRIDGE_SECRET ), $signature ) ) {
        return mansu_online_error( 'mansu_signature', 'A recent signed service request is required.', 403 );
    }
    return true;
}
function mansu_online_ready() {
    global $wpdb;
    if ( ! mansu_online_enabled() || ! defined( 'WC_VERSION' ) || WC_VERSION !== MANSU_ONLINE_PINNED_WOO ||
         ! function_exists( 'wc_create_order' ) || ! function_exists( 'wc_get_order' ) ||
         ! function_exists( 'wc_get_product' ) || ! function_exists( 'wc_release_stock_for_order' ) ||
         ! function_exists( 'wc_tax_enabled' ) || ! function_exists( 'as_schedule_single_action' ) ||
         ! class_exists( '\\Automattic\\WooCommerce\\Checkout\\Helpers\\ReserveStock' ) ||
         get_option( 'woocommerce_schema_version', 0 ) < 430 ||
         get_option( 'woocommerce_manage_stock' ) !== 'yes' ||
         ! apply_filters( 'woocommerce_hold_stock_for_checkout', true ) ||
         get_woocommerce_currency() !== 'GHS' ) {
        return mansu_online_error( 'mansu_unverified', 'Required pinned local Woo behavior is unavailable.', 503 );
    }
    $required = array( mansu_online_table(), $wpdb->wc_reserved_stock, $wpdb->posts, $wpdb->postmeta,
        $wpdb->prefix . 'wc_product_meta_lookup', $wpdb->prefix . 'woocommerce_order_items',
        $wpdb->prefix . 'woocommerce_order_itemmeta' );
    if ( class_exists( '\\Automattic\\WooCommerce\\Utilities\\OrderUtil' ) &&
         \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled() ) {
        foreach ( array( 'wc_orders', 'wc_orders_meta', 'wc_order_addresses', 'wc_order_operational_data' ) as $name ) {
            $required[] = $wpdb->prefix . $name;
        }
    }
    foreach ( $required as $table ) {
        $engine = $wpdb->get_var( $wpdb->prepare( 'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s', $table ) );
        if ( strtoupper( (string) $engine ) !== 'INNODB' ) {
            return mansu_online_error( 'mansu_engine', 'Verified InnoDB order/hold tables are required.', 503 );
        }
    }
    return true;
}
function mansu_online_row( $key ) {
    global $wpdb;
    $table = mansu_online_table();
    return $wpdb->get_row( $wpdb->prepare( "SELECT * FROM $table WHERE service=%s AND attempt_key=%s", MANSU_ONLINE_BRIDGE_SERVICE, $key ), ARRAY_A );
}
function mansu_online_update( $key, $data, $from = null ) {
    global $wpdb;
    $where = array( 'service' => MANSU_ONLINE_BRIDGE_SERVICE, 'attempt_key' => $key );
    if ( $from !== null ) { $where['state'] = $from; }
    $data['updated_at'] = current_time( 'mysql', true );
    return $wpdb->update( mansu_online_table(), $data, $where );
}
function mansu_online_input( $request ) {
    $input = $request->get_json_params();
    $keys = array( 'service', 'ledgerId', 'key', 'fingerprint', 'cashierId', 'shiftId', 'saleType',
        'items', 'quoteHash', 'approvedBy', 'approvedAt', 'buyerId', 'buyerName' );
    if ( ! is_array( $input ) || array_diff( array_keys( $input ), $keys ) ||
         ( $input['service'] ?? '' ) !== MANSU_ONLINE_BRIDGE_SERVICE ||
         ( $input['ledgerId'] ?? '' ) !== MANSU_ONLINE_BRIDGE_LEDGER_ID ||
         ! mansu_online_uuid( $input['key'] ?? null ) ||
         ! is_string( $input['fingerprint'] ?? null ) || ! preg_match( '/^[a-f0-9]{64}$/D', $input['fingerprint'] ) ||
         ! mansu_online_uuid( $input['cashierId'] ?? null ) || ! mansu_online_uuid( $input['shiftId'] ?? null ) ||
         ! in_array( $input['saleType'] ?? '', array( 'retail', 'wholesale' ), true ) ||
         ! is_array( $input['items'] ?? null ) || count( $input['items'] ) < 1 || count( $input['items'] ) > 100 ) {
        return mansu_online_error( 'mansu_payload', 'Invalid POS attempt identity or cart.', 400 );
    }
    if ( $input['saleType'] === 'retail' && array_intersect( array_keys( $input ), array( 'quoteHash', 'approvedBy', 'approvedAt', 'buyerId', 'buyerName' ) ) ) {
        return mansu_online_error( 'mansu_quote', 'Retail cannot supply a wholesale quote.', 400 );
    }
    if ( $input['saleType'] === 'wholesale' ) {
        if ( ! mansu_online_uuid( $input['approvedBy'] ?? null ) || $input['approvedBy'] !== $input['cashierId'] ||
             ! is_string( $input['quoteHash'] ?? null ) || ! preg_match( '/^[a-f0-9]{64}$/D', $input['quoteHash'] ) ||
             ! is_string( $input['approvedAt'] ?? null ) || ! preg_match( '/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/D', $input['approvedAt'] ) ||
             ! is_string( $input['buyerName'] ?? null ) || strlen( $input['buyerName'] ) > 120 ||
             preg_match( '/[\x00-\x1f\x7f]/', $input['buyerName'] ) ||
             ! is_string( $input['buyerId'] ?? null ) || ( $input['buyerId'] !== '' && ! mansu_online_uuid( $input['buyerId'] ) ) ) {
            return mansu_online_error( 'mansu_quote', 'A signed approved wholesale quote is required.', 400 );
        }
        // Exact tax-inclusive negotiated pricing cannot be guessed from tax
        // settings. Stop until installed Woo tax allocation is separately proven.
        if ( wc_tax_enabled() ) {
            return mansu_online_error( 'mansu_tax', 'Wholesale tax allocation is not verified.', 409 );
        }
    }
    $seen = array();
    foreach ( $input['items'] as $item ) {
        if ( ! is_array( $item ) || array_diff( array_keys( $item ), array( 'productId', 'variationId', 'quantity',
                'expectedUnitCents', 'ownerId', 'sku', 'agreedUnitCents' ) ) ||
             ! mansu_online_int( $item['productId'] ?? null, 1, 2147483647 ) ||
             ! mansu_online_int( $item['variationId'] ?? null, 0, 2147483647 ) ||
             ! mansu_online_int( $item['quantity'] ?? null, 1, 999 ) ||
             ! mansu_online_int( $item['expectedUnitCents'] ?? null, 1, 100000000 ) ||
             ! mansu_online_int( $item['ownerId'] ?? null, 1, 2147483647 ) ||
             ! is_string( $item['sku'] ?? null ) || strlen( $item['sku'] ) > 100 ||
             ( $input['saleType'] === 'wholesale' && ! mansu_online_int( $item['agreedUnitCents'] ?? null, 1, 100000000 ) ) ||
             ( $input['saleType'] === 'retail' && isset( $item['agreedUnitCents'] ) ) ) {
            return mansu_online_error( 'mansu_item', 'Invalid product, quantity or price.', 400 );
        }
        $identity = $item['productId'] . ':' . $item['variationId'];
        if ( isset( $seen[ $identity ] ) ) { return mansu_online_error( 'mansu_item', 'Duplicate product option.', 400 ); }
        $seen[ $identity ] = true;
    }
    return $input;
}
function mansu_online_products( $input ) {
    $result = array(); $owners = array();
    foreach ( $input['items'] as $item ) {
        $parent = wc_get_product( $item['productId'] );
        $product = wc_get_product( $item['variationId'] ?: $item['productId'] );
        if ( ! $parent || ! $product ||
             ( $item['variationId'] && ( ! $parent->is_type( 'variable' ) || ! $product->is_type( 'variation' ) ||
                 (int) $product->get_parent_id() !== $item['productId'] ) ) ||
             ( ! $item['variationId'] && ! $product->is_type( 'simple' ) ) ||
             $parent->get_status() !== 'publish' || $product->get_status() !== 'publish' ||
             ! $product->is_purchasable() || ! $product->is_in_stock() ||
             $product->is_virtual() || $product->is_downloadable() ||
             $product->backorders_allowed() || $product->is_sold_individually() && $item['quantity'] !== 1 ||
             mansu_online_money( $product->get_price() ) !== $item['expectedUnitCents'] ||
             $product->get_sku() !== $item['sku'] ) {
            return mansu_online_error( 'mansu_product', 'Published stock product, option, SKU or catalogue price changed.', 409 );
        }
        $owner_id = (int) $product->get_stock_managed_by_id();
        $owner = $owner_id ? wc_get_product( $owner_id ) : null;
        if ( $owner_id !== $item['ownerId'] || ! $owner || ! $product->managing_stock() ||
             ! $owner->managing_stock() || $owner->backorders_allowed() ||
             ! mansu_online_int( $owner->get_stock_quantity(), 0, 2147483647 ) ) {
            return mansu_online_error( 'mansu_owner', 'Managed stock owner or quantity is unknown.', 409 );
        }
        $owners[ $owner_id ] = ( $owners[ $owner_id ] ?? 0 ) + $item['quantity'];
        $result[] = $product;
    }
    foreach ( $owners as $owner_id => $quantity ) {
        if ( wc_get_product( $owner_id )->get_stock_quantity() < $quantity ) {
            return mansu_online_error( 'mansu_stock', 'Requested units exceed the stock owner pool.', 409 );
        }
    }
    return $result; // Display/eligibility check only; Woo's lock is admission.
}
function mansu_online_holds( $order_id, $items ) {
    global $wpdb;
    $expected = array();
    foreach ( $items as $item ) { $expected[ $item['ownerId'] ] = ( $expected[ $item['ownerId'] ] ?? 0 ) + $item['quantity']; }
    $rows = $wpdb->get_results( $wpdb->prepare( "SELECT product_id,stock_quantity,
        TIMESTAMPDIFF(SECOND,NOW(),expires) AS remaining FROM {$wpdb->wc_reserved_stock} WHERE order_id=%d", $order_id ), ARRAY_A );
    if ( ! is_array( $rows ) || count( $rows ) !== count( $expected ) ) { return array( false, null, 0 ); }
    $min = PHP_INT_MAX;
    foreach ( $rows as $hold ) {
        $id = (int) $hold['product_id'];
        $remaining = (int) $hold['remaining'];
        if ( ! isset( $expected[ $id ] ) || (int) $hold['stock_quantity'] !== $expected[ $id ] ||
             $remaining < 1 || $remaining > MANSU_ONLINE_HOLD_MINUTES * 60 + 5 ) {
            return array( false, null, 0 );
        }
        $min = min( $min, $remaining );
        unset( $expected[ $id ] );
    }
    return array( empty( $expected ), gmdate( 'c', time() + $min ), $min );
}
function mansu_online_meta( $order, $expected ) {
    $found = array();
    foreach ( $order->get_meta_data() as $meta ) {
        $data = $meta->get_data();
        $name = $data['key'] ?? '';
        if ( isset( $expected[ $name ] ) ) { $found[ $name ][] = (string) ( $data['value'] ?? '' ); }
    }
    foreach ( $expected as $name => $value ) {
        if ( count( $found[ $name ] ?? array() ) !== 1 || $found[ $name ][0] !== (string) $value ) { return false; }
    }
    return true;
}
function mansu_online_order_view( $row ) {
    $stored = json_decode( $row['items_json'], true );
    $context = json_decode( $row['context_json'], true );
    $items = array(); $order = (int) $row['order_id'] ? wc_get_order( (int) $row['order_id'] ) : null;
    $expected = is_array( $context ) ? array(
        '_mansu_pos_key' => $row['attempt_key'], '_mansu_pos_channel' => 'mansu-pos',
        '_mansu_pos_cashier' => $context['cashierId'] ?? '',
        '_mansu_bridge_shift' => $context['shiftId'] ?? '',
        '_mansu_pos_sale_type' => $context['saleType'] ?? '',
        '_mansu_bridge_service' => $row['service'], '_mansu_bridge_ledger' => $row['ledger_id'],
        '_mansu_bridge_site' => MANSU_ONLINE_BRIDGE_SITE_ID,
        '_mansu_bridge_payload_hash' => $row['payload_hash'], '_mansu_bridge_fingerprint' => $row['fingerprint'],
    ) : array();
    if ( ( $context['saleType'] ?? '' ) === 'wholesale' ) {
        $expected['_mansu_pos_quote_hash'] = $context['quoteHash'];
        $expected['_mansu_pos_wholesale_approver'] = $context['approvedBy'];
        $expected['_mansu_pos_wholesale_approved_at'] = $context['approvedAt'];
        if ( $context['buyerId'] ) { $expected['_mansu_pos_wholesale_buyer_id'] = $context['buyerId']; }
    }
    $identity = $order && is_array( $stored ) && count( $stored ) > 0 && count( $expected ) > 0 &&
        mansu_online_meta( $order, $expected ) &&
        ( ( $context['saleType'] ?? '' ) !== 'wholesale' || $order->get_billing_first_name() === $context['buyerName'] ) &&
        $order->get_currency() === 'GHS' &&
        mansu_online_money( $order->get_total() ) === (int) $row['total_cents'] &&
        mansu_online_money( $order->get_total_tax() ) === (int) $row['tax_cents'] &&
        mansu_online_money( $order->get_shipping_total() ) === 0 &&
        mansu_online_money( $order->get_discount_total() ) === 0 &&
        ! count( $order->get_items( 'fee' ) ) && ! count( $order->get_items( 'coupon' ) ) &&
        ! count( $order->get_items( 'shipping' ) );
    if ( $identity ) {
        $lines = $order->get_items( 'line_item' );
        $remaining = $stored; $line_gross = 0; $line_tax = 0;
        foreach ( $lines as $line ) {
            $p = (int) $line->get_product_id(); $v = (int) $line->get_variation_id();
            $matches = array_filter( $remaining, static fn( $item ) => $item['productId'] === $p && $item['variationId'] === $v );
            if ( count( $matches ) !== 1 ) { $identity = false; break; }
            $item = reset( $matches );
            $product = wc_get_product( $v ?: $p );
            $tax = mansu_online_money( $line->get_total_tax() );
            $net = mansu_online_money( $line->get_total() );
            $gross = $net + $tax;
            if ( ! $product || $product->get_sku() !== $item['sku'] ||
                 (int) $product->get_stock_managed_by_id() !== $item['ownerId'] ||
                 (int) $line->get_quantity() !== $item['quantity'] ||
                 mansu_online_money( $line->get_subtotal() ) !== $net ||
                 $gross !== ( $item['agreedUnitCents'] ?? $item['expectedUnitCents'] ) * $item['quantity'] ||
                 $tax < 0 || $net < 0 ) { $identity = false; break; }
            $line_gross += $gross; $line_tax += $tax;
            $items[] = array( 'productId' => $p, 'variationId' => $v, 'quantity' => $item['quantity'],
                'ownerId' => $item['ownerId'], 'unitCents' => $item['expectedUnitCents'],
                'agreedUnitCents' => $item['agreedUnitCents'] ?? null, 'sku' => $item['sku'],
                'grossCents' => $gross, 'taxCents' => $tax );
            $remaining = array_filter( $remaining, static fn( $entry ) => $entry['productId'] !== $p || $entry['variationId'] !== $v );
        }
        if ( count( $lines ) !== count( $stored ) || $remaining ||
             $line_gross !== (int) $row['total_cents'] || $line_tax !== (int) $row['tax_cents'] ) { $identity = false; }
    }
    if ( ! $identity ) {
        // Before the order was created, expose only the claim identity. Never
        // invent a verified order/hold from a stale mapping or an edited order.
        $items = is_array( $stored ) ? array_map( static fn( $item ) => array(
            'productId' => $item['productId'], 'variationId' => $item['variationId'],
            'quantity' => $item['quantity'], 'ownerId' => $item['ownerId'],
            'unitCents' => $item['expectedUnitCents'], 'agreedUnitCents' => $item['agreedUnitCents'] ?? null,
            'sku' => $item['sku'], 'grossCents' => 0, 'taxCents' => 0 ), $stored ) : array();
    }
    $pending = $identity && $order->has_status( 'pending' ) && ! $order->get_date_paid();
    list( $hold, $expiry, $seconds ) = $pending ? mansu_online_holds( $order->get_id(), $stored ) : array( false, null, 0 );
    // Distinguish the order-level flag from full per-line proof: an externally
    // reduced or partially reduced pending order is NOT a fresh cash hold.
    $stock_reduced_flag = $identity && (bool) $order->get_data_store()->get_stock_reduced( $order->get_id() );
    $stock_reduced = $stock_reduced_flag;
    $line_reduction_seen = false;
    if ( $identity ) {
        foreach ( $order->get_items( 'line_item' ) as $line ) {
            $reduced_quantity = (int) $line->get_meta( '_reduced_stock', true );
            if ( $reduced_quantity !== 0 ) { $line_reduction_seen = true; }
            if ( $stock_reduced && $reduced_quantity !== (int) $line->get_quantity() ) { $stock_reduced = false; }
        }
    }
    $cash_intent_seen = $identity && (string) $order->get_meta( '_mansu_online_cash_intent', true ) !== '';
    $cash_intent_exact = $identity && $order->get_meta( '_mansu_online_cash_intent', true ) === $row['attempt_key'];
    $hold_count = $identity ? $GLOBALS['wpdb']->get_var( $GLOBALS['wpdb']->prepare(
        "SELECT COUNT(*) FROM {$GLOBALS['wpdb']->wc_reserved_stock} WHERE order_id=%d", $order->get_id() ) ) : null;
    // A failed DB read is not proof that a paid/cancelled hold was released.
    $released = $hold_count !== null && $hold_count !== false &&
        ctype_digit( (string) $hold_count ) && (int) $hold_count === 0;
    $paid = $identity && $stock_reduced && $released &&
        $order->get_payment_method() === 'pos_cash' &&
        $order->get_meta( '_mansu_online_cash_intent', true ) === $row['attempt_key'] &&
        $order->get_date_paid() && $order->has_status( array( 'processing', 'completed' ) ) &&
        (int) $row['total_cents'] > 0;
    $cancelled = $identity && $released && $order->has_status( 'cancelled' ) && ! $order->get_date_paid() &&
        ! $stock_reduced_flag && ! $line_reduction_seen && ! $cash_intent_seen;
    $state = $row['state'];
    if ( $paid && in_array( $state, array( 'payment_started', 'paid', 'needs_review' ), true ) ) { $state = 'paid'; }
    elseif ( $cancelled && in_array( $state, array( 'cancel_started', 'cancelled', 'needs_review' ), true ) ) { $state = 'cancelled'; }
    elseif ( $row['order_id'] && ! $identity ||
             $state === 'reserved' && ( ! $pending || ! $hold || $stock_reduced_flag || $line_reduction_seen || $cash_intent_seen ) ||
             $state === 'cash_intent' && ( ! $pending || ! $hold || $stock_reduced_flag || $line_reduction_seen || ! $cash_intent_exact ) ||
             $state === 'paid' && ! $paid || $state === 'cancelled' && ! $cancelled ) { $state = 'needs_review'; }
    $paid_at = $paid && $order->get_date_paid() ? $order->get_date_paid()->date( 'c' ) : null;
    return array( 'siteId' => MANSU_ONLINE_BRIDGE_SITE_ID, 'service' => $row['service'],
        'ledgerId' => $row['ledger_id'], 'key' => $row['attempt_key'], 'fingerprint' => $row['fingerprint'],
        'state' => $state, 'orderId' => (int) $row['order_id'] ?: null,
        'totalCents' => (int) $row['total_cents'], 'taxCents' => (int) $row['tax_cents'],
        'expiresAt' => $expiry, 'items' => $items,
        'reservationVerified' => $state === 'reserved' && $hold && $seconds >= 1 &&
            ! $stock_reduced_flag && ! $line_reduction_seen && ! $cash_intent_seen,
        'cashIntentVerified' => $state === 'cash_intent' && $pending && $hold && $seconds >= 1 &&
            $cash_intent_exact && ! $stock_reduced_flag && ! $line_reduction_seen,
        'paymentVerified' => $state === 'paid' && $paid,
        'cancelledVerified' => $state === 'cancelled' && $cancelled,
        // Internal cancellation gate; no credentials, names or raw Woo metadata.
        'orderIdentityVerified' => (bool) $identity,
        'stockOrCashIntentObserved' => $stock_reduced_flag || $line_reduction_seen || $cash_intent_seen,
        'refundedCents' => $order && $identity ? mansu_online_money( $order->get_total_refunded() ) : 0,
        'paidAt' => $paid_at );
}
// Signed read-only health report. Prerequisites do NOT prove an actual
// simultaneous website/POS last-unit stock race is safe on the installed site.
function mansu_online_health( $request ) {
    $ready = mansu_online_ready();
    if ( is_wp_error( $ready ) ) { return $ready; }
    $hpos = class_exists( '\\Automattic\\WooCommerce\\Utilities\\OrderUtil' ) &&
        \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled();
    return array( 'kind' => 'mansu-online-bridge-health', 'ok' => true,
        'service' => MANSU_ONLINE_BRIDGE_SERVICE, 'ledgerId' => MANSU_ONLINE_BRIDGE_LEDGER_ID,
        'siteId' => MANSU_ONLINE_BRIDGE_SITE_ID, 'wooVersion' => WC_VERSION,
        'corePrerequisitesOk' => true, 'cashOnly' => true, 'taxEnabled' => (bool) wc_tax_enabled(),
        'hposEnabled' => (bool) $hpos,
        // CI on pinned Woo 11.0.1 reproduces negative stock when an old online
        // gateway payment arrives AFTER its hold expires and POS sells the
        // last unit. This is permanently FALSE until a separately reviewed
        // Woo/Paystack-side admission and recovery guard actually exists.
        // Never turn it on via a copied environment flag or owner approval.
        'lateGatewayGuardVerified' => false );
}
function mansu_online_attempt( $request ) {
    global $wpdb;
    $ready = mansu_online_ready();
    if ( is_wp_error( $ready ) ) { return $ready; }
    $input = mansu_online_input( $request );
    if ( is_wp_error( $input ) ) { return $input; }
    $key = $input['key'];
    $payload_hash = hash( 'sha256', wp_json_encode( $input ) );
    $row = mansu_online_row( $key );
    if ( $row ) {
        if ( $row['fingerprint'] !== $input['fingerprint'] || $row['payload_hash'] !== $payload_hash ||
             $row['ledger_id'] !== $input['ledgerId'] ) {
            return mansu_online_error( 'mansu_conflict', 'The attempt key is already bound to different details.', 409 );
        }
        return mansu_online_order_view( $row ); // no re-reservation/extension on replay.
    }
    $products = mansu_online_products( $input );
    if ( is_wp_error( $products ) ) { return $products; }
    $table = mansu_online_table();
    $context = array( 'cashierId' => $input['cashierId'], 'shiftId' => $input['shiftId'],
        'saleType' => $input['saleType'], 'quoteHash' => $input['quoteHash'] ?? '',
        'approvedBy' => $input['approvedBy'] ?? '', 'approvedAt' => $input['approvedAt'] ?? '',
        'buyerId' => $input['buyerId'] ?? '', 'buyerName' => $input['buyerName'] ?? '' );
    $claim = $wpdb->query( $wpdb->prepare( "INSERT IGNORE INTO $table
        (service,attempt_key,ledger_id,fingerprint,payload_hash,items_json,context_json,state,created_at,updated_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,'claimed',UTC_TIMESTAMP(),UTC_TIMESTAMP())",
        MANSU_ONLINE_BRIDGE_SERVICE, $key, $input['ledgerId'], $input['fingerprint'],
        $payload_hash, wp_json_encode( $input['items'] ), wp_json_encode( $context ) ) );
    if ( $claim !== 1 ) {
        $row = mansu_online_row( $key );
        if ( ! $row ) { return mansu_online_error( 'mansu_storage', 'Unique attempt claim was not saved.', 503 ); }
        if ( $row['fingerprint'] !== $input['fingerprint'] || $row['payload_hash'] !== $payload_hash ||
             $row['ledger_id'] !== $input['ledgerId'] ) {
            return mansu_online_error( 'mansu_conflict', 'The attempt key is already bound to different details.', 409 );
        }
        return mansu_online_order_view( $row );
    }
    $order = null;
    try {
        // A crash after this claim NEVER creates a second order on replay.
        $order = wc_create_order( array( 'status' => 'pending', 'created_via' => 'mansu-pos-bridge' ) );
        if ( ! $order || is_wp_error( $order ) ) { throw new RuntimeException( 'Order creation failed.' ); }
        $order->set_created_via( 'mansu-pos-bridge' );
        $order->set_currency( 'GHS' );
        $order->set_payment_method( 'pos_cash' );
        $order->update_meta_data( '_mansu_pos_key', $key );
        $order->update_meta_data( '_mansu_pos_channel', 'mansu-pos' );
        $order->update_meta_data( '_mansu_pos_cashier', $input['cashierId'] );
        $order->update_meta_data( '_mansu_bridge_service', $input['service'] );
        $order->update_meta_data( '_mansu_bridge_ledger', $input['ledgerId'] );
        $order->update_meta_data( '_mansu_bridge_site', MANSU_ONLINE_BRIDGE_SITE_ID );
        $order->update_meta_data( '_mansu_bridge_fingerprint', $input['fingerprint'] );
        $order->update_meta_data( '_mansu_bridge_shift', $input['shiftId'] );
        $order->update_meta_data( '_mansu_bridge_payload_hash', $payload_hash );
        $order->update_meta_data( '_mansu_pos_sale_type', $input['saleType'] );
        if ( $input['saleType'] === 'wholesale' ) {
            $order->update_meta_data( '_mansu_pos_quote_hash', $input['quoteHash'] );
            $order->update_meta_data( '_mansu_pos_wholesale_approver', $input['approvedBy'] );
            $order->update_meta_data( '_mansu_pos_wholesale_approved_at', $input['approvedAt'] );
            if ( $input['buyerId'] ) { $order->update_meta_data( '_mansu_pos_wholesale_buyer_id', $input['buyerId'] ); }
            if ( $input['buyerName'] ) { $order->set_billing_first_name( $input['buyerName'] ); }
        }
        foreach ( $input['items'] as $index => $item ) {
            $item_id = $order->add_product( $products[ $index ], $item['quantity'] );
            if ( ! $item_id ) { throw new RuntimeException( 'Woo order item creation failed.' ); }
            if ( $input['saleType'] === 'wholesale' ) {
                $line = $order->get_item( $item_id );
                $gross = $item['agreedUnitCents'] * $item['quantity'];
                $line->set_subtotal( number_format( $gross / 100, 2, '.', '' ) );
                $line->set_total( number_format( $gross / 100, 2, '.', '' ) );
                $line->save();
            }
        }
        $order->calculate_totals( $input['saleType'] !== 'wholesale' );
        $order->save();
        $total = mansu_online_money( $order->get_total() );
        $tax = mansu_online_money( $order->get_total_tax() );
        $expected = array_reduce( $input['items'], static fn( $sum, $item ) =>
            $sum + ( $item['agreedUnitCents'] ?? $item['expectedUnitCents'] ) * $item['quantity'], 0 );
        if ( $total < 1 || $total > 100000000 || $tax < 0 || $tax > $total || $total !== $expected ) {
            throw new RuntimeException( 'Gross quote or tax allocation changed in Woo.' );
        }
        if ( mansu_online_update( $key, array( 'order_id' => $order->get_id(),
                'total_cents' => $total, 'tax_cents' => $tax, 'state' => 'created' ), 'claimed' ) !== 1 ) {
            throw new RuntimeException( 'Woo order mapping was not saved.' );
        }
        // Woo core, not custom _stock SQL. The pinned ReserveStock helper
        // aggregates variation stock by get_stock_managed_by_id(), locks and
        // conditionally inserts a same-order hold. It may be filtered: read
        // back *every* owner/quantity/expiry before claiming success.
        $reserve = new \Automattic\WooCommerce\Checkout\Helpers\ReserveStock();
        $reserve->reserve_stock_for_order( $order, MANSU_ONLINE_HOLD_MINUTES );
        list( $valid ) = mansu_online_holds( $order->get_id(), $input['items'] );
        if ( ! $valid ) { throw new RuntimeException( 'Core Woo hold could not be verified.' ); }
        $job = as_schedule_single_action( time() + MANSU_ONLINE_HOLD_MINUTES * 60, 'mansu_online_expire',
            array( MANSU_ONLINE_BRIDGE_SERVICE, $key ), 'mansu-online' );
        if ( ! $job || mansu_online_update( $key, array( 'state' => 'reserved' ), 'created' ) !== 1 ) {
            throw new RuntimeException( 'Hold expiry scheduling or state could not be saved.' );
        }
        $view = mansu_online_order_view( mansu_online_row( $key ) );
        if ( $view['state'] !== 'reserved' || ! $view['reservationVerified'] ) {
            throw new RuntimeException( 'Woo order/hold readback was not verified.' );
        }
        return $view;
    } catch ( Throwable $error ) {
        // Woo may have saved an order or hold before the error, and another POS
        // process may have seen it. Keep the unique claim and observed ID, but
        // never infer from this request failing that no cash was taken. Do not
        // auto-cancel or release stock; require same-key owner review.
        $order_id = $order && ! is_wp_error( $order ) ? (int) $order->get_id() : 0;
        mansu_online_update( $key, array( 'state' => 'needs_review', 'order_id' => $order_id ) );
        return mansu_online_error( 'mansu_uncertain', 'Order/hold outcome is uncertain; the attempt is quarantined.', 503 );
    }
}
function mansu_online_status( $request ) {
    $ready = mansu_online_ready();
    if ( is_wp_error( $ready ) ) { return $ready; }
    $key = $request['key'];
    if ( ! mansu_online_uuid( $key ) ) { return mansu_online_error( 'mansu_key', 'Invalid attempt key.', 400 ); }
    $row = mansu_online_row( $key );
    if ( ! $row || $row['ledger_id'] !== MANSU_ONLINE_BRIDGE_LEDGER_ID ) {
        return mansu_online_error( 'mansu_missing', 'The same-key mapping is unavailable; do not create another order.', 404 );
    }
    return mansu_online_order_view( $row ); // Pure read: no hold extension or order writes.
}
function mansu_online_cancel_key( $key ) {
    global $wpdb;
    $row = mansu_online_row( $key );
    if ( ! $row || $row['ledger_id'] !== MANSU_ONLINE_BRIDGE_LEDGER_ID ) {
        return mansu_online_error( 'mansu_missing', 'The attempt is not bound to this ledger.', 404 );
    }
    $view = mansu_online_order_view( $row );
    if ( $view['state'] === 'cancelled' && $view['cancelledVerified'] ) { return $view; }
    if ( $row['state'] !== 'reserved' || ! $row['order_id'] || ! $view['orderIdentityVerified'] ||
         $view['stockOrCashIntentObserved'] || $view['paymentVerified'] || $view['refundedCents'] !== 0 ) {
        return mansu_online_error( 'mansu_review', 'Only the original untouched unpaid POS reservation can be cancelled.', 409 );
    }
    if ( mansu_online_update( $key, array( 'state' => 'cancel_started' ), 'reserved' ) !== 1 ) {
        return mansu_online_error( 'mansu_busy', 'The attempt changed; refresh the same-key status.', 409 );
    }
    try {
        $latest = mansu_online_order_view( mansu_online_row( $key ) );
        if ( ! $latest['orderIdentityVerified'] || $latest['stockOrCashIntentObserved'] ||
             $latest['refundedCents'] !== 0 || $latest['paymentVerified'] ) {
            throw new RuntimeException( 'Order, stock or cash intent changed during cancellation.' );
        }
        $order = wc_get_order( (int) $row['order_id'] );
        if ( ! $order || ! $order->has_status( 'pending' ) || $order->get_date_paid() ||
             ! mansu_online_meta( $order, array( '_mansu_pos_key' => $key,
                '_mansu_bridge_ledger' => $row['ledger_id'], '_mansu_bridge_site' => MANSU_ONLINE_BRIDGE_SITE_ID ) ) ) {
            throw new RuntimeException( 'Order is not this unpaid POS attempt.' );
        }
        $order->update_status( 'cancelled', 'Unpaid local POS hold cancelled.' );
        wc_release_stock_for_order( $order );
        $remaining = $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->wc_reserved_stock} WHERE order_id=%d", $order->get_id() ) );
        if ( ! $order->has_status( 'cancelled' ) || $remaining === null || $remaining === false ||
             ! ctype_digit( (string) $remaining ) || (int) $remaining !== 0 ) {
            throw new RuntimeException( 'Release or cancellation is uncertain.' );
        }
        if ( mansu_online_update( $key, array( 'state' => 'cancelled' ), 'cancel_started' ) !== 1 ) {
            throw new RuntimeException( 'Cancelled mapping was not saved.' );
        }
        return mansu_online_order_view( mansu_online_row( $key ) );
    } catch ( Throwable $error ) {
        mansu_online_update( $key, array( 'state' => 'needs_review' ) );
        return mansu_online_error( 'mansu_review', 'Cancellation outcome is uncertain. Do not pay or re-create.', 409 );
    }
}
function mansu_online_cancel( $request ) {
    $ready = mansu_online_ready();
    if ( is_wp_error( $ready ) ) { return $ready; }
    if ( ! mansu_online_uuid( $request['key'] ) ) { return mansu_online_error( 'mansu_key', 'Invalid attempt key.', 400 ); }
    return mansu_online_cancel_key( $request['key'] );
}
function mansu_online_cash_intent( $request ) {
    $ready = mansu_online_ready();
    if ( is_wp_error( $ready ) ) { return $ready; }
    $key = $request['key'];
    if ( ! mansu_online_uuid( $key ) || $request->get_json_params() !== array() ) {
        return mansu_online_error( 'mansu_cash_payload', 'Only an empty signed same-key cash-intent request is accepted.', 400 );
    }
    $row = mansu_online_row( $key );
    if ( ! $row || $row['ledger_id'] !== MANSU_ONLINE_BRIDGE_LEDGER_ID ) {
        return mansu_online_error( 'mansu_missing', 'This attempt is not bound to the original ledger.', 404 );
    }
    $view = mansu_online_order_view( $row );
    if ( $row['state'] === 'cash_intent' && $view['cashIntentVerified'] ) {
        return $view; // Read-only replay, not another stock hold.
    }
    if ( $row['state'] !== 'reserved' || $view['state'] !== 'reserved' ||
         ! $view['orderIdentityVerified'] || ! $view['reservationVerified'] ||
         $view['stockOrCashIntentObserved'] || $view['paymentVerified'] || $view['refundedCents'] !== 0 ) {
        return mansu_online_error( 'mansu_cash_review', 'Original untouched hold is not verified.', 409 );
    }
    $items = json_decode( $row['items_json'], true );
    list( $held, , $seconds ) = mansu_online_holds( (int) $row['order_id'], $items );
    if ( ! $held || $seconds < MANSU_ONLINE_CASH_MARGIN_SECONDS ) {
        return mansu_online_error( 'mansu_expired', 'Original hold is too near expiry.', 409 );
    }
    // Durable claim before touching Woo metadata blocks concurrent cancellation.
    if ( mansu_online_update( $key, array( 'state' => 'cash_intent' ), 'reserved' ) !== 1 ) {
        return mansu_online_error( 'mansu_busy', 'Cash intent already started. Review the same order.', 409 );
    }
    try {
        $order = wc_get_order( (int) $row['order_id'] );
        if ( ! $order || ! $order->has_status( 'pending' ) || $order->get_date_paid() ||
             ! mansu_online_meta( $order, array( '_mansu_pos_key' => $key,
                 '_mansu_bridge_ledger' => $row['ledger_id'], '_mansu_bridge_site' => MANSU_ONLINE_BRIDGE_SITE_ID ) ) ||
             (string) $order->get_meta( '_mansu_online_cash_intent', true ) !== '' ) {
            throw new RuntimeException( 'Original pending order or its cash-intent marker changed.' );
        }
        list( $held, , $seconds ) = mansu_online_holds( $order->get_id(), $items );
        if ( ! $held || $seconds < MANSU_ONLINE_CASH_MARGIN_SECONDS ) {
            throw new RuntimeException( 'Original stock hold changed during cash intent.' );
        }
        $order->update_meta_data( '_mansu_online_cash_intent', $key );
        $order->save();
        $verified = mansu_online_order_view( mansu_online_row( $key ) );
        if ( $verified['state'] !== 'cash_intent' || ! $verified['cashIntentVerified'] ) {
            throw new RuntimeException( 'Cash intent and Woo stock hold were not verified.' );
        }
        return $verified;
    } catch ( Throwable $error ) {
        // An unknown outcome can NEVER revert to a fresh payable reservation.
        mansu_online_update( $key, array( 'state' => 'needs_review' ), 'cash_intent' );
        return mansu_online_error( 'mansu_cash_uncertain', 'Original Woo cash intent requires review.', 503 );
    }
}
function mansu_online_pay( $request ) {
    $ready = mansu_online_ready();
    if ( is_wp_error( $ready ) ) { return $ready; }
    $key = $request['key'];
    if ( ! mansu_online_uuid( $key ) || $request->get_json_params() !== array() ) {
        return mansu_online_error( 'mansu_cash_payload', 'Only a same-key, cash-only payment intent is accepted.', 400 );
    }
    $row = mansu_online_row( $key );
    if ( ! $row || $row['ledger_id'] !== MANSU_ONLINE_BRIDGE_LEDGER_ID ) {
        return mansu_online_error( 'mansu_missing', 'This attempt is not bound to the local ledger.', 404 );
    }
    $view = mansu_online_order_view( $row );
    if ( $view['state'] === 'paid' && $view['paymentVerified'] ) { return $view; } // Read-only replay.
    if ( $row['state'] !== 'cash_intent' || $view['state'] !== 'cash_intent' ||
         ! $view['orderIdentityVerified'] || ! $view['cashIntentVerified'] ||
         ! $view['stockOrCashIntentObserved'] || $view['paymentVerified'] ||
         $view['refundedCents'] !== 0 ) {
        return mansu_online_error( 'mansu_cash_review', 'Original Woo cash-intent acknowledgement is not verified.', 409 );
    }
    $items = json_decode( $row['items_json'], true );
    list( $hold, , $remaining ) = mansu_online_holds( (int) $row['order_id'], $items );
    if ( ! $hold || $remaining < MANSU_ONLINE_CASH_MARGIN_SECONDS ) {
        return mansu_online_error( 'mansu_expired', 'The stock hold is too close to expiry; treat the cash as a review liability.', 409 );
    }
    // Conservative check against external stock edits/late website callbacks.
    // This read is NOT an installed-site atomic gateway/stock guarantee.
    $owners = array();
    foreach ( $items as $item ) { $owners[ $item['ownerId'] ] = ( $owners[ $item['ownerId'] ] ?? 0 ) + $item['quantity']; }
    foreach ( $owners as $owner_id => $quantity ) {
        $owner = wc_get_product( $owner_id );
        if ( ! $owner || ! mansu_online_int( $owner->get_stock_quantity(), $quantity, 2147483647 ) ) {
            return mansu_online_error( 'mansu_stock_changed', 'Woo stock changed while cash was held; owner review required.', 409 );
        }
    }
    if ( mansu_online_update( $key, array( 'state' => 'payment_started' ), 'cash_intent' ) !== 1 ) {
        return mansu_online_error( 'mansu_busy', 'Payment already started. Use read-only status.', 409 );
    }
    try {
        $order = wc_get_order( (int) $row['order_id'] );
        if ( ! $order || ! $order->has_status( 'pending' ) || $order->get_date_paid() ||
             $order->get_payment_method() !== 'pos_cash' ||
             ! mansu_online_meta( $order, array( '_mansu_pos_key' => $key,
                '_mansu_bridge_ledger' => $row['ledger_id'], '_mansu_bridge_site' => MANSU_ONLINE_BRIDGE_SITE_ID ) ) ) {
            throw new RuntimeException( 'Original pending cash order changed.' );
        }
        if ( $order->get_meta( '_mansu_online_cash_intent', true ) !== $key ) {
            throw new RuntimeException( 'The original cash intent changed.' );
        }
        if ( ! $order->payment_complete() ) { throw new RuntimeException( 'Woo payment was not completed.' ); }
        $observed = mansu_online_order_view( mansu_online_row( $key ) );
        if ( $observed['state'] !== 'paid' || ! $observed['paymentVerified'] ) {
            throw new RuntimeException( 'Native Woo stock reduction, paid status or hold release is not verified.' );
        }
        if ( mansu_online_update( $key, array( 'state' => 'paid' ), 'payment_started' ) !== 1 ) {
            throw new RuntimeException( 'Paid state could not be saved.' );
        }
        return mansu_online_order_view( mansu_online_row( $key ) );
    } catch ( Throwable $error ) {
        // Never re-send payment_complete on retry. A read-only status may later
        // recover verified paid evidence; otherwise a human reviews the money.
        return mansu_online_error( 'mansu_payment_uncertain', 'Woo payment or stock reduction is uncertain. Review the original attempt.', 503 );
    }
}
function mansu_online_expire( $service, $key ) {
    if ( ! mansu_online_enabled() || $service !== MANSU_ONLINE_BRIDGE_SERVICE || ! mansu_online_uuid( $key ) ) { return; }
    $ready = mansu_online_ready();
    if ( is_wp_error( $ready ) ) { return; }
    $row = mansu_online_row( $key );
    if ( ! $row || ! in_array( $row['state'], array( 'reserved', 'cash_intent', 'payment_started' ), true ) ) { return; }
    if ( $row['state'] === 'reserved' ) {
        $view = mansu_online_order_view( $row );
        if ( $view['reservationVerified'] ) {
            as_schedule_single_action( time() + 30, 'mansu_online_expire', array( $service, $key ), 'mansu-online' );
            return; // Never renew the hold in a read/status/expiry path.
        }
    }
    // A POS may have committed physical cash to its local ledger and crashed
    // before POST /pay wrote any Woo cash-intent marker. Absence of a marker is
    // NOT proof of no cash; even an apparently unpaid expired order must not be
    // cancelled by this worker. Core hold expiry does not make POS cash safe.
    mansu_online_update( $key, array( 'state' => 'needs_review' ), $row['state'] );
}
// This guard is only loaded with the disabled-by-default bridge. It protects
// Woo's native payment_complete() and stock-reduction hooks from expired
// website reservations. It is NOT a complete Paystack callback admission
// guarantee; gateways can bypass payment_complete()/Woo stock hooks and other
// plugins may modify stock directly. Live trading attestation remains FALSE.
function mansu_online_website_order( $order ) {
    // The classic checkout writes "checkout"; Woo Checkout Block / Store
    // API writes "store-api". Protect BOTH, without intercepting unrelated
    // manual admin or POS orders.
    return mansu_online_enabled() && $order instanceof WC_Order &&
        in_array( $order->get_created_via(), array( 'checkout', 'store-api' ), true ) &&
        $order->get_payment_method() !== 'pos_cash';
}
function mansu_online_website_hold_safe( $order, $minimum_seconds = 30 ) {
    global $wpdb;
    // A previously quarantined gateway payment must NEVER be auto-admitted
    // merely because a later job/manual edit created another Woo reservation.
    // The original payment needs audited Owner/Manager reconciliation first.
    if ( ! $order || ! $order->get_id() ||
         $order->get_meta( '_mansu_website_stock_review', true ) === 'required' ) { return false; }
    $expected = array();
    $items = $order->get_items( 'line_item' );
    if ( ! $items || ! is_array( $items ) ) { return false; }
    foreach ( $items as $line ) {
        $product = $line->get_product();
        if ( ! $product || ! $product->managing_stock() || $product->backorders_allowed() ) {
            return false;
        }
        $id = (int) $product->get_stock_managed_by_id();
        $quantity = (int) $line->get_quantity();
        if ( $id < 1 || $quantity < 1 ) { return false; }
        $expected[ $id ] = ( $expected[ $id ] ?? 0 ) + $quantity;
    }
    if ( ! $expected ) { return false; }
    $holds = $wpdb->get_results( $wpdb->prepare(
        "SELECT product_id,stock_quantity,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),expires) AS remaining
            FROM {$wpdb->wc_reserved_stock} WHERE order_id=%d", $order->get_id() ), ARRAY_A );
    if ( ! is_array( $holds ) || count( $holds ) !== count( $expected ) ) { return false; }
    foreach ( $holds as $hold ) {
        $id = (int) $hold['product_id'];
        if ( ! isset( $expected[ $id ] ) ||
             (int) $hold['stock_quantity'] !== $expected[ $id ] ||
             (int) $hold['remaining'] < $minimum_seconds ) {
            return false;
        }
        unset( $expected[ $id ] );
    }
    return ! $expected;
}
function mansu_online_website_review( $order, $reason ) {
    if ( $order->get_meta( '_mansu_website_stock_review', true ) !== 'required' ) {
        $order->update_meta_data( '_mansu_website_stock_review', 'required' );
        $order->save();
        $order->add_order_note( 'Mansu stock safety: delayed or unverified website gateway payment. Retain gateway proof; do not fulfil, restock, retry a POS sale or issue an automatic refund. Owner/Manager review required. Reason: ' . $reason );
    }
}
// A native payment_complete() call that started with a valid Woo hold must
// not be quarantined later in the SAME request just because Woo releases
// that hold while transitioning the order status. Never persist this as an
// evergreen authorization: a later callback must verify a NEW live hold.
function mansu_online_website_payment_seen( $order_id, $mark = false ) {
    static $verified = array();
    if ( $mark ) { $verified[ (int) $order_id ] = true; }
    return isset( $verified[ (int) $order_id ] );
}
// This is request-local evidence only; never persist it as a payment or stock
// approval. It records which Woo orders entered a serialized Paystack WC-API
// handler so direct WC core/manual hooks continue to use the normal guards.
function mansu_online_paystack_request_lock_expected( $order_id, $mark = false ) {
    static $expect = array();
    if ( $mark ) { $expect[ (int) $order_id ] = true; }
    return ! empty( $expect[ (int) $order_id ] );
}
function mansu_online_paystack_request_lock_retained( $order_id ) {
    if ( ! mansu_online_paystack_request_lock_expected( $order_id ) ) { return true; }
    global $wpdb;
    // MySQL GET_LOCK belongs to a CONNECTION, not to a PHP request. A lost
    // connection silently frees it. Reconnecting must not permit payment on
    // a stale order snapshot while another worker owns the same stock.
    $name = 'mansu-paystack-order-' . (int) $order_id;
    $held = $wpdb->get_var( $wpdb->prepare(
        'SELECT CASE WHEN IS_USED_LOCK(%s) = CONNECTION_ID() THEN 1 ELSE 0 END', $name
    ) );
    return (string) $held === '1';
}
function mansu_online_pre_website_payment( $order_id, $transaction_id = '' ) {
    $order = wc_get_order( (int) $order_id );
    if ( ! mansu_online_website_order( $order ) || $order->get_date_paid() ) { return; }
    // The public Paystack return handler derives the Woo order ID from the
    // verified transaction reference, but does not itself compare it to
    // _paystack_txn_ref on the original order. A valid hold alone must NOT
    // authorize a payment from a different payment attempt. Fail closed for
    // the specifically inspected Paystack gateway; other gateways retain
    // the native hold check and require separate installed-site acceptance.
    $reference_safe = true;
    if ( $order->get_payment_method() === 'paystack' ) {
        $expected_ref = $order->get_meta( '_paystack_txn_ref', true );
        $reference_safe = is_string( $expected_ref ) && $expected_ref !== '' &&
            is_string( $transaction_id ) && $transaction_id !== '' &&
            hash_equals( $expected_ref, $transaction_id );
    }
    $callback_lock_safe = $order->get_payment_method() !== 'paystack' ||
        mansu_online_paystack_request_lock_retained( $order_id );
    if ( $reference_safe && $callback_lock_safe && mansu_online_website_hold_safe( $order ) ) {
        mansu_online_website_payment_seen( $order_id, true );
        return;
    }
    mansu_online_website_review( $order, ! $callback_lock_safe ?
        'Paystack MySQL callback lock lost after connection reset; external payment requires reconciliation' :
        ( $reference_safe ? 'payment callback without a valid original stock hold' :
        'Paystack payment reference does not match the order original attempt' ) );
    // The external payment may already have settled. Keep it in a review-only
    // Woo status, not 'pending': Paystack exits on repeat callbacks for an
    // on-hold order, avoiding repeated success notifications. Our stock
    // reducer filter still denies deductions from the quarantined order.
    // This is a status change only; never issue a refund or claim settlement.
    if ( ! $order->has_status( 'on-hold' ) ) {
        $order->update_status( 'on-hold', 'Website gateway callback requires stock and settlement review; no fulfilment.' );
    }
    // Woo WC_Order::payment_complete() catches this exception, leaving the
    // original order and real gateway transfer available for human review.
    throw new RuntimeException( 'Original website stock hold expired or is unverified; do not fulfil this paid gateway attempt.' );
}
function mansu_online_can_reduce_website_stock( $can, $order ) {
    if ( ! $can || ! mansu_online_website_order( $order ) ) { return $can; }
    if ( $order->get_payment_method() === 'paystack' &&
         ! mansu_online_paystack_request_lock_retained( $order->get_id() ) ) {
        mansu_online_website_review( $order, 'Paystack callback lost DB advisory lock before stock deduction' );
        return false;
    }
    // Woo can set its order-level 'stock reduced' flag after an earlier
    // status-hook attempt was DENIED. Paystack may then call the reducer a
    // second time (e.g. currency mismatch). The order flag is NOT evidence
    // of an item deduction and must never bypass hold/quarantine checks.
    // An actually reduced full set of line items is safe from a second
    // deduction by Woo core; never use this exception for review orders.
    if ( $order->get_meta( '_mansu_website_stock_review', true ) !== 'required' &&
         mansu_online_website_items_reduced( $order ) ) { return $can; }
    if ( mansu_online_website_hold_safe( $order ) ) { return $can; }
    // Woo's order_status_processing/completed/on-hold actions can call stock
    // reduction independently of payment_complete(). Deny that path too.
    mansu_online_website_review( $order, 'unverified original hold before stock reduction' );
    return false;
}
// Woo wc_maybe_reduce_stock_levels() marks the order-level stock flag TRUE
// even if another plugin's woocommerce_can_reduce_order_stock filter denied
// the actual item reduction. Never treat that boolean alone as proof.
function mansu_online_website_items_reduced( $order ) {
    $lines = $order->get_items( 'line_item' );
    if ( ! $lines ) { return false; }
    foreach ( $lines as $line ) {
        $quantity = (int) $line->get_quantity();
        if ( $quantity < 1 || (int) $line->get_meta( '_reduced_stock', true ) !== $quantity ) {
            return false;
        }
    }
    return true;
}
function mansu_online_website_status_review( $order_id, $from, $to, $order ) {
    static $reviewing = false;
    if ( $reviewing || ! in_array( $to, array( 'processing', 'completed', 'on-hold' ), true ) ||
         ! mansu_online_website_order( $order ) ||
         mansu_online_website_payment_seen( $order_id ) ||
         mansu_online_website_items_reduced( $order ) ||
         mansu_online_website_hold_safe( $order ) ) {
        return;
    }
    $reviewing = true;
    try {
        mansu_online_website_review( $order, 'direct paid-status transition without a valid hold' );
        // Paystack can mark a short-paid order on-hold directly, without
        // calling Woo payment_complete() or reducing stock. Preserve that
        // status but attach the same owner-review evidence for expired holds.
        // Paid processing/completed bypasses must be moved to on-hold.
        if ( $to !== 'on-hold' ) {
            $order->update_status( 'on-hold', 'Website payment requires stock and gateway reconciliation before fulfilment.' );
        }
    } finally {
        $reviewing = false;
    }
}
/**
 * Fail closed BEFORE Paystack charges a saved-card token. Paystack 5.8.6
 * directly calls wp_remote_post(charge_authorization) in process_token_payment
 * and may return success even if WC_Order::payment_complete() later fails.
 * The pre_http_request filter can refuse the outgoing request with WP_Error.
 *
 * This protects only the inspected Paystack v5.8.6 token-charge URL. It does
 * NOT prove external settlement, refund safety, or generic Paystack coverage.
 */
function mansu_online_paystack_pre_token_charge( $preempt, $args, $url ) {
    if ( ! mansu_online_enabled() ||
         $url !== 'https://api.paystack.co/transaction/charge_authorization' ) {
        return $preempt;
    }
    $refuse = static function () {
        // No customer payment data or gateway secrets in a public error.
        return new WP_Error( 'mansu_token_stock_unsafe',
            'Saved-card charge could not be safely authorised. Check the original order before retrying.' );
    };
    $body = $args['body'] ?? null;
    if ( ! is_string( $body ) || strlen( $body ) > 16384 ) { return $refuse(); }
    $data = json_decode( $body, true );
    if ( ! is_array( $data ) || ! isset( $data['reference'], $data['amount'], $data['currency'],
                 $data['authorization_code'] ) ||
         ! is_string( $data['reference'] ) || ! is_int( $data['amount'] ) ||
         ! is_string( $data['currency'] ) || ! is_string( $data['authorization_code'] ) ||
         $data['authorization_code'] === '' ||
         ! preg_match( '/^([1-9][0-9]{0,11})_[0-9]+$/D', $data['reference'], $match ) ) {
        return $refuse();
    }
    $order_id = (int) $match[1];
    $order = wc_get_order( $order_id );
    if ( ! mansu_online_website_order( $order ) ||
         $order->get_payment_method() !== 'paystack' ||
         ! $order->has_status( 'pending' ) ||
         $order->get_meta( '_mansu_website_stock_review', true ) === 'required' ||
         $order->get_currency() !== $data['currency'] ||
         (int) round( (float) $order->get_total() * 100 ) !== $data['amount'] ) {
        return $refuse();
    }
    $saved_reference = $order->get_meta( '_paystack_txn_ref', true );
    if ( ! is_string( $saved_reference ) ||
         ! hash_equals( $saved_reference, $data['reference'] ) ) {
        return $refuse();
    }
    global $wpdb;
    $lock_name = 'mansu-paystack-order-' . $order_id;
    // The same MySQL advisory lock serialises signed callbacks, returns and
    // token charge admission. Never charge without owning it.
    $locked = $wpdb->get_var( $wpdb->prepare(
        'SELECT GET_LOCK(%s, %d)', $lock_name, 20
    ) );
    if ( (string) $locked !== '1' ) { return $refuse(); }
    register_shutdown_function( static function () use ( $wpdb, $lock_name ) {
        $wpdb->get_var( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $lock_name ) );
    } );
    // Reload canonical status through the lock-owning connection. A second
    // worker must not charge based on a cached pending WC_Order snapshot.
    $hpos = class_exists( '\\Automattic\\WooCommerce\\Utilities\\OrderUtil' ) &&
        \\Automattic\\WooCommerce\\Utilities\\OrderUtil::custom_orders_table_usage_is_enabled();
    $table = $hpos ? $wpdb->prefix . 'wc_orders' : $wpdb->posts;
    $column = $hpos ? 'status' : 'post_status';
    $status = $wpdb->get_var( $wpdb->prepare(
        "SELECT {$column} FROM {$table} WHERE id=%d", $order_id
    ) );
    $fresh = wc_get_order( $order_id );
    $fresh_reference = $fresh instanceof WC_Order ?
        $fresh->get_meta( '_paystack_txn_ref', true ) : '';
    if ( $status !== 'wc-pending' || ! mansu_online_website_order( $fresh ) ||
         $fresh->get_payment_method() !== 'paystack' ||
         ! is_string( $fresh_reference ) ||
         ! hash_equals( $fresh_reference, $data['reference'] ) ||
         ! mansu_online_paystack_original_hold_safe( $fresh ) ) {
        $wpdb->get_var( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $lock_name ) );
        return $refuse();
    }
    // Retain ownership through the entire outgoing charge and native Woo
    // payment/stock processing; request-local hook rechecks this connection.
    mansu_online_paystack_request_lock_expected( $order_id, true );
    if ( ! mansu_online_paystack_request_lock_retained( $order_id ) ) {
        $wpdb->get_var( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $lock_name ) );
        return $refuse();
    }
    return $preempt;
}
add_filter( 'pre_http_request', 'mansu_online_paystack_pre_token_charge', 1, 3 );

// A fresh website checkout reservation is mandatory BEFORE an external
// Paystack callback or browser return may reach the gateway's success path.
// Reserve a short margin for the gateway's network verification; the later
// payment_complete() hook MUST still re-check the hold and stock atomically.
function mansu_online_paystack_original_hold_safe( $order ) {
    return mansu_online_website_hold_safe( $order, MANSU_ONLINE_PAYSTACK_ENTRY_MARGIN_SECONDS );
}
/**
 * Pinned Paystack 5.8.6 saved-card precharge guard. Its process_token_payment()
 * writes _paystack_txn_ref and then calls wp_remote_post() for
 * /transaction/charge_authorization BEFORE Woo payment_complete(). No Woo
 * payment or postcharge hook can undo that external money movement.
 *
 * This runs at the last WordPress-managed outbound boundary and rejects a
 * missing, expiring or mismatched original website stock reservation BEFORE
 * Paystack receives the charge request. A 90-second minimum covers Paystack's
 * 60-second HTTP timeout plus a conservative response/processing margin.
 * Final postcharge stock/payment guards remain mandatory: network timeouts,
 * late webhooks and other gateway entry points can still require reconciliation.
 */
function mansu_online_paystack_token_charge_matches( $order, $payload ) {
    if ( ! mansu_online_website_order( $order ) || ! $order->has_status( 'pending' ) ||
         $order->get_date_paid() || $order->get_payment_method() !== 'paystack' ||
         ! is_array( $payload ) || ! isset( $payload['reference'], $payload['amount'], $payload['currency'] ) ||
         ! is_string( $payload['reference'] ) || ! is_int( $payload['amount'] ) ||
         ! is_string( $payload['currency'] ) ) {
        return false;
    }
    $ref = (string) $order->get_meta( '_paystack_txn_ref', true );
    $expected_amount = (int) round( (float) $order->get_total() * 100 );
    return $ref !== '' && hash_equals( $ref, $payload['reference'] ) &&
        $expected_amount > 0 && $expected_amount === $payload['amount'] &&
        $payload['currency'] === $order->get_currency() &&
        ! mansu_online_website_items_reduced( $order ) &&
        mansu_online_paystack_original_hold_safe( $order );
}
function mansu_online_paystack_saved_token_precharge( $preempt, $args, $url ) {
    if ( ! mansu_online_enabled() ||
         $url !== 'https://api.paystack.co/transaction/charge_authorization' ||
         $preempt !== false ) {
        return $preempt;
    }
    // Scope to the exact Paystack gateway method. Other integrations can
    // legitimately call the same Paystack API (e.g. recurring subscriptions),
    // and must not be silently treated as Woo saved-card orders.
    $from_gateway = false;
    foreach ( debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS, 16 ) as $frame ) {
        if ( ( $frame['class'] ?? '' ) === 'WC_Gateway_Paystack' &&
             ( $frame['function'] ?? '' ) === 'process_token_payment' ) {
            $from_gateway = true;
            break;
        }
    }
    if ( ! $from_gateway ) { return $preempt; }
    $blocked = static function () {
        // WP_Http will return this without issuing ANY external POST. The
        // upstream gateway then fails checkout without a success redirect.
        // Never claim a captured charge was refunded or ask to pay twice.
        return new WP_Error( 'mansu_paystack_saved_card_precharge_blocked',
            'Saved-card payment was not started because stock could not be verified. Contact the store before trying again.' );
    };
    if ( ! defined( 'WC_PAYSTACK_VERSION' ) || WC_PAYSTACK_VERSION !== '5.8.6' ||
         ( $args['method'] ?? '' ) !== 'POST' ||
         ! is_string( $args['body'] ?? null ) ) {
        return $blocked();
    }
    $payload = json_decode( $args['body'], true );
    if ( ! is_array( $payload ) || ! is_string( $payload['reference'] ?? null ) ||
         ! preg_match( '/^([1-9][0-9]{0,11})_[0-9]+$/D', $payload['reference'], $match ) ) {
        return $blocked();
    }
    $order_id = (int) $match[1];
    global $wpdb;
    $lock_name = 'mansu-paystack-order-' . $order_id;
    // Serialize the external charge, subsequent Woo completion and concurrent
    // gateway webhook/return against ONE original Woo order. GET_LOCK is
    // connection-owned, not transaction-owned; hold through PHP shutdown.
    $owned = $wpdb->get_var( $wpdb->prepare(
        'SELECT CASE WHEN IS_USED_LOCK(%s) = CONNECTION_ID() THEN 1 ELSE 0 END', $lock_name
    ) );
    if ( (string) $owned !== '1' ) {
        $locked = $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, %d)', $lock_name, 20 ) );
        if ( (string) $locked !== '1' ) { return $blocked(); }
        register_shutdown_function( static function () use ( $wpdb, $lock_name ) {
            $wpdb->get_var( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $lock_name ) );
        } );
    }
    mansu_online_paystack_request_lock_expected( $order_id, true );
    if ( ! mansu_online_paystack_request_lock_retained( $order_id ) ) {
        return $blocked();
    }
    $order = wc_get_order( $order_id );
    if ( ! mansu_online_paystack_token_charge_matches( $order, $payload ) ) {
        return $blocked();
    }
    return $preempt; // Native Paystack HTTP request may now start.
}
add_filter( 'pre_http_request', 'mansu_online_paystack_saved_token_precharge', 1, 3 );

/**
 * DRAFT ONLY: serialize the actual Paystack v5.8.6 WC-API entry points for
 * each website order, BEFORE upstream code fetches its order object.
 *
 * Two PHP workers can both verify one payment and then use stale pending
 * WC_Order snapshots. The native Woo pre-payment/stock hooks alone cannot
 * prevent a later stale callback from overwriting a legitimately paid order
 * with on-hold/review, even when only one stock unit was deducted.
 *
 * MySQL GET_LOCK is scoped to this request's DB connection, covers both
 * webhook and return URL, and is explicitly released on PHP shutdown. This
 * relies on the same connection surviving for the duration of the gateway
 * handler. The installed Paystack version/settings are NOT verified; the
 * release flag remains false and this must never enable production writes.
 */
function mansu_online_paystack_route_lock() {
    if ( ! mansu_online_enabled() || ! function_exists( 'wc_get_order' ) ) { return; }
    $is_webhook = current_filter() === 'woocommerce_api_tbz_wc_paystack_webhook';
    $reference = '';
    if ( $is_webhook ) {
        if ( ( $_SERVER['REQUEST_METHOD'] ?? '' ) !== 'POST' ) { return; }
        // php://input is seekable/re-readable in supported PHP 8.x. Only
        // inspect the claimed order ID to serialize; real Paystack must still
        // verify HMAC, remote transaction, amount and reference itself.
        $raw_event = file_get_contents( 'php://input' );
        $event = json_decode( $raw_event );
        if ( ! is_object( $event ) || ( $event->event ?? '' ) !== 'charge.success' ||
             ! isset( $event->data->reference ) || ! is_string( $event->data->reference ) ) { return; }
        // A claimed order number is not authority to block its lock. Refuse
        // unsigned/forged requests BEFORE acquiring a MySQL advisory lock.
        // This is version-specific to the public gateway tested in CI.
        $gateway_settings = get_option( 'woocommerce_paystack_settings', array() );
        if ( ! is_array( $gateway_settings ) ) { status_header( 503 ); exit; }
        $mode = ( $gateway_settings['testmode'] ?? 'no' ) === 'yes' ? 'test' : 'live';
        $secret = $gateway_settings[ $mode . '_secret_key' ] ?? '';
        $signature = $_SERVER['HTTP_X_PAYSTACK_SIGNATURE'] ?? '';
        if ( ! is_string( $secret ) || $secret === '' ) { status_header( 503 ); exit; }
        if ( ! is_string( $signature ) ||
             ! hash_equals( hash_hmac( 'sha512', $raw_event, $secret ), $signature ) ) {
            status_header( 401 );
            exit;
        }
        $reference = $event->data->reference;
    } else {
        // Public Paystack return accepts either query key.
        $raw_reference = $_REQUEST['paystack_txnref'] ?? $_REQUEST['reference'] ?? null;
        if ( ! is_string( $raw_reference ) ) { return; }
        $reference = sanitize_text_field( wp_unslash( $raw_reference ) );
    }
    // Untrusted payment-return URLs must not be able to monopolize a
    // genuine order's advisory lock merely by guessing its numeric ID.
    // Reject before GET_LOCK; this is not proof of external settlement.
    if ( ! preg_match( '/^([1-9][0-9]{0,11})_/', $reference, $matches ) ) {
        status_header( 403 );
        exit;
    }
    $order_id = (int) $matches[1];
    $original = wc_get_order( $order_id );
    $saved_ref = $original instanceof WC_Order ?
        $original->get_meta( '_paystack_txn_ref', true ) : '';
    if ( ! mansu_online_website_order( $original ) ||
         $original->get_payment_method() !== 'paystack' ||
         ! is_string( $saved_ref ) || $saved_ref === '' ||
         ! hash_equals( $saved_ref, $reference ) ) {
        status_header( 403 );
        exit;
    }
    global $wpdb;
    $lock_name = 'mansu-paystack-order-' . $order_id;
    // MySQL advisory lock is shared by all PHP workers using this DB. A
    // timed-out request MUST NOT run the upstream gateway on stale state.
    $locked = $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, %d)', $lock_name, 20 ) );
    if ( (string) $locked !== '1' ) {
        status_header( 503 );
        exit;
    }
    // Register release IMMEDIATELY after GET_LOCK. The status recheck may
    // exit early on an already-paid/quarantined order, and some Woo stores
    // use persistent DB connections: skipping release would poison retries.
    register_shutdown_function( static function () use ( $wpdb, $lock_name ) {
        $wpdb->get_var( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $lock_name ) );
    } );
    // Re-read after acquiring the lock; a concurrent callback may have
    // changed the original attempt or gateway while this request waited.
    $order = wc_get_order( $order_id );
    $locked_ref = $order instanceof WC_Order ?
        $order->get_meta( '_paystack_txn_ref', true ) : '';
    if ( ! mansu_online_website_order( $order ) ||
         $order->get_payment_method() !== 'paystack' ||
         ! is_string( $locked_ref ) || $locked_ref === '' ||
         ! hash_equals( $locked_ref, $reference ) ) {
        $wpdb->get_var( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $lock_name ) );
        status_header( 403 );
        exit;
    }
    // Snapshot reads before GET_LOCK are NOT authoritative. In particular,
    // the order object may have been primed in this PHP worker while another
    // callback was finishing. A new wc_get_order() alone can hit that same
    // request cache and replay paid status / duplicate gateway success notes.
    // Read the canonical Woo status directly from the SAME MySQL connection
    // that owns the advisory lock, before entering upstream Paystack code.
    // HPOS and legacy CPT are deliberately explicit; an unsupported/missing
    // status fails closed instead of inferring an unpaid order from the cache.
    $hpos = class_exists( '\\Automattic\\WooCommerce\\Utilities\\OrderUtil' ) &&
        \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled();
    $table = $hpos ? $wpdb->prefix . 'wc_orders' : $wpdb->posts;
    $status_column = $hpos ? 'status' : 'post_status';
    $db_status = $wpdb->get_var( $wpdb->prepare(
        "SELECT {$status_column} FROM {$table} WHERE id=%d", $order_id
    ) );
    if ( ! is_string( $db_status ) || $db_status === '' ) {
        status_header( 503 );
        exit;
    }
    // A previous callback already left pending. Do not re-run the gateway
    // on a stale WC_Order (which can overwrite paid state with on-hold/review).
    // For an already-paid return, navigate to the canonical Woo order receipt.
    // A quarantined on-hold order is not a new authorization to ship goods.
    if ( $db_status !== 'wc-pending' ) {
        if ( in_array( $db_status, array( 'wc-processing', 'wc-completed',
                 'wc-refunded', 'wc-on-hold' ), true ) ) {
            if ( ! $is_webhook ) {
                wp_safe_redirect( $order->get_checkout_order_received_url() );
            } else {
                status_header( 200 );
            }
            exit;
        }
        // Cancelled/failed/draft orders may have returned their hold. A
        // signed external success still needs human settlement reconciliation.
        status_header( 409 );
        exit;
    }
    // An expired or nearly expired original hold must never enter the
    // gateway success path. Paystack may have already settled externally:
    // quarantine this ORIGINAL order for manual settlement review, and do
    // not display/acknowledge an ordinary completed sale or consume POS stock.
    // This does not reverse a charge; never ask a customer to pay again.
    if ( ! mansu_online_paystack_original_hold_safe( $order ) ) {
        if ( $is_webhook ) {
            // This request carried a valid Paystack webhook HMAC, so its
            // external-success CLAIM deserves Owner reconciliation. We must
            // not infer settlement, mark paid, allocate stock or fulfil.
            mansu_online_website_review( $order, 'Signed Paystack webhook arrived without an original hold valid for the verification margin' );
            if ( $order->has_status( 'pending' ) ) {
                $order->update_status( 'on-hold', 'External Paystack settlement unconfirmed; no fulfilment until Owner review.' );
            }
            // This is ONLY an acknowledgement of the signed webhook's
            // delivery. The Woo order stays on hold for manual settlement
            // reconciliation and must not fulfil or reduce stock. Paystack
            // retries non-200 events for days; replaying a securely recorded
            // quarantine would increase noise without making stock safer.
            status_header( 200 );
        } else {
            // A browser return query is NOT signed payment evidence. An
            // attacker with a leaked reference must not be able to quarantine
            // a pending order just by visiting the return URL.
            wp_die(
                'We could not confirm this order. If you were charged, please contact the store before trying to pay again.',
                'Order requires verification',
                array( 'response' => 409 )
            );
        }
        exit;
    }
    // Assert the same connection still owns the lock after Woo identity
    // reads, and remember that later payment/stock hooks MUST recheck it.
    mansu_online_paystack_request_lock_expected( $order_id, true );
    if ( ! mansu_online_paystack_request_lock_retained( $order_id ) ) {
        status_header( 503 );
        exit;
    }
    // Gateway proceeds only on a still-pending order while this request
    // owns the lock. Shutdown releases it on every path, including PHP exit.
}
add_action( 'woocommerce_api_tbz_wc_paystack_webhook', 'mansu_online_paystack_route_lock', 0 );
add_action( 'woocommerce_api_wc_gateway_paystack', 'mansu_online_paystack_route_lock', 0 );

add_action( 'woocommerce_pre_payment_complete', 'mansu_online_pre_website_payment', 1, 2 );
add_filter( 'woocommerce_can_reduce_order_stock', 'mansu_online_can_reduce_website_stock', 1, 2 );
add_action( 'woocommerce_order_status_changed', 'mansu_online_website_status_review', 1, 4 );

function mansu_online_routes() {
    register_rest_route( 'mansu-pos/v1', '/health', array( 'methods' => 'GET',
        'permission_callback' => 'mansu_online_permission', 'callback' => 'mansu_online_health' ) );
    register_rest_route( 'mansu-pos/v1', '/attempts', array( 'methods' => 'POST',
        'permission_callback' => 'mansu_online_permission', 'callback' => 'mansu_online_attempt' ) );
    register_rest_route( 'mansu-pos/v1', '/attempts/(?P<key>[0-9a-f-]{36})', array( 'methods' => 'GET',
        'permission_callback' => 'mansu_online_permission', 'callback' => 'mansu_online_status' ) );
    register_rest_route( 'mansu-pos/v1', '/attempts/(?P<key>[0-9a-f-]{36})/cash-intent', array( 'methods' => 'POST',
        'permission_callback' => 'mansu_online_permission', 'callback' => 'mansu_online_cash_intent' ) );
    register_rest_route( 'mansu-pos/v1', '/attempts/(?P<key>[0-9a-f-]{36})/pay', array( 'methods' => 'POST',
        'permission_callback' => 'mansu_online_permission', 'callback' => 'mansu_online_pay' ) );
    register_rest_route( 'mansu-pos/v1', '/attempts/(?P<key>[0-9a-f-]{36})/cancel', array( 'methods' => 'POST',
        'permission_callback' => 'mansu_online_permission', 'callback' => 'mansu_online_cancel' ) );
}
add_action( 'rest_api_init', 'mansu_online_routes' );
add_action( 'mansu_online_expire', 'mansu_online_expire', 10, 2 );
