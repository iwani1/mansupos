<?php
/**
 * Fresh-GitHub-runner-only, REAL WooCommerce/SQL simultaneous reserve test.
 * Never execute against live products, orders, credentials, or a hosted site.
 */
if ( ! defined( 'WP_CLI' ) || ! WP_CLI || ! defined( 'MANSU_CI_DISPOSABLE_WOO' ) ||
     MANSU_CI_DISPOSABLE_WOO !== true || wp_get_environment_type() !== 'local' ||
     get_option( 'blogname' ) !== 'Mansu isolated CI stock test' ||
     ! defined( 'MANSU_ONLINE_BRIDGE_SERVICE' ) || MANSU_ONLINE_BRIDGE_SERVICE !== 'staging' ||
     ! defined( 'WC_VERSION' ) || WC_VERSION !== '11.0.1' || ! function_exists( 'mansu_online_attempt' ) ) {
    throw new RuntimeException( 'Disposable WordPress identity rejected: refusing reservation test.' );
}
$dir = getenv( 'MANSU_RACE_DIR' );
$stage = getenv( 'MANSU_RACE_STAGE' );
$kind = getenv( 'MANSU_RACE_KIND' );
$side = getenv( 'MANSU_RACE_SIDE' );
if ( ! is_string( $dir ) || ! is_dir( $dir ) ||
     ! in_array( $stage, array( 'setup', 'worker', 'verify' ), true ) ||
     ! in_array( $kind, array( 'simple', 'shared' ), true ) ) {
    throw new RuntimeException( 'Missing disposable race arguments.' );
}
$fixture_path = $dir . '/fixture.json';
if ( $stage === 'setup' ) {
    if ( $kind === 'simple' ) {
        $product = new WC_Product_Simple();
        $product->set_name( 'SYNTHETIC RACE LAST UNIT' );
        $product->set_status( 'publish' );
        $product->set_regular_price( '100.00' );
        $product->set_manage_stock( true );
        $product->set_stock_quantity( 1 );
        $product->set_backorders( 'no' );
        $product->set_sku( 'MANSU-RACE-' . wp_generate_uuid4() );
        $product->save();
        $owner = (int) $product->get_id();
        $ids = array( $owner, $owner );
    } else {
        $parent = new WC_Product_Variable();
        $parent->set_name( 'SYNTHETIC RACE SHARED PARENT' );
        $parent->set_status( 'publish' );
        $parent->set_manage_stock( true );
        $parent->set_stock_quantity( 1 );
        $parent->set_backorders( 'no' );
        $parent->save();
        $owner = (int) $parent->get_id();
        $ids = array();
        foreach ( array( 'A', 'B' ) as $label ) {
            $v = new WC_Product_Variation();
            $v->set_parent_id( $owner );
            $v->set_status( 'publish' );
            $v->set_regular_price( '100.00' );
            $v->set_manage_stock( false );
            $v->set_sku( 'MANSU-RACE-' . $label . '-' . wp_generate_uuid4() );
            $v->save();
            $ids[] = (int) $v->get_id();
        }
    }
    if ( file_put_contents( $fixture_path, wp_json_encode( array(
        'kind' => $kind, 'ownerId' => $owner, 'productIds' => $ids,
    ) ), LOCK_EX ) === false ) {
        throw new RuntimeException( 'Could not save fresh synthetic stock-owner fixture.' );
    }
    echo 'DISPOSABLE_RACE_SETUP_OK' . PHP_EOL;
    return;
}
$fixture = json_decode( file_get_contents( $fixture_path ), true );
if ( ! is_array( $fixture ) || ( $fixture['kind'] ?? '' ) !== $kind ||
     count( $fixture['productIds'] ?? array() ) !== 2 ) {
    throw new RuntimeException( 'Unknown disposable stock-owner fixture.' );
}
if ( $stage === 'worker' ) {
    $channel = getenv( 'MANSU_RACE_CHANNEL' );
    if ( ! in_array( $side, array( 'a', 'b' ), true ) ||
         ! in_array( $channel, array( 'website', 'pos' ), true ) ) {
        throw new RuntimeException( 'Unknown synthetic checkout channel.' );
    }
    $product_id = (int) $fixture['productIds'][ $side === 'a' ? 0 : 1 ];
    $product = wc_get_product( $product_id );
    if ( ! $product || (int) $product->get_stock_managed_by_id() !== (int) $fixture['ownerId'] ) {
        throw new RuntimeException( 'Synthetic product/parent stock owner changed.' );
    }
    if ( file_put_contents( $dir . '/ready-' . $side, 'ready', LOCK_EX ) === false ) {
        throw new RuntimeException( 'Unable to join shared two-process barrier.' );
    }
    $deadline = microtime( true ) + 22;
    while ( ! is_file( $dir . '/start' ) && microtime( true ) < $deadline ) { usleep( 5000 ); }
    if ( ! is_file( $dir . '/start' ) ) { throw new RuntimeException( 'Race start signal timed out.' ); }
    $result = array( 'channel' => $channel, 'success' => false, 'orderId' => null,
        'state' => 'unstarted', 'error' => null, 'productId' => $product_id );
    try {
        if ( $channel === 'website' ) {
            $order = wc_create_order( array( 'status' => 'pending', 'created_via' => 'checkout' ) );
            if ( ! $order || is_wp_error( $order ) ) { throw new RuntimeException( 'Website order creation failed.' ); }
            $result['orderId'] = (int) $order->get_id();
            $order->add_product( $product, 1 );
            $order->calculate_totals( false );
            $order->save();
            $reserve = new \Automattic\WooCommerce\Checkout\Helpers\ReserveStock();
            $reserve->reserve_stock_for_order( $order, 10 );
            global $wpdb;
            $held = (int) $wpdb->get_var( $wpdb->prepare(
                "SELECT stock_quantity FROM {$wpdb->wc_reserved_stock} WHERE order_id=%d AND product_id=%d AND expires > UTC_TIMESTAMP()",
                $order->get_id(), $fixture['ownerId'] ) );
            if ( $held !== 1 ) { throw new RuntimeException( 'Website original-order hold was not saved.' ); }
            $result['success'] = true;
            $result['state'] = 'reserved';
        } else {
            $key = wp_generate_uuid4();
            $payload = array(
                'service' => 'staging', 'ledgerId' => MANSU_ONLINE_BRIDGE_LEDGER_ID,
                'key' => $key, 'fingerprint' => str_repeat( 'a', 64 ),
                'cashierId' => '3c4e759e-cf64-4f8a-94bd-f978b737a985',
                'shiftId' => '39fda408-7303-42c5-bbdf-e89ed1eb4c5b',
                'saleType' => 'retail', 'items' => array( array(
                    'productId' => (int) $fixture['ownerId'],
                    'variationId' => $kind === 'shared' ? $product_id : 0,
                    'quantity' => 1, 'expectedUnitCents' => 10000,
                    'ownerId' => (int) $fixture['ownerId'], 'sku' => $product->get_sku(),
                ) ),
            );
            $req = new WP_REST_Request( 'POST', '/mansu-pos/v1/attempts' );
            $req->set_header( 'content-type', 'application/json' );
            $req->set_body( wp_json_encode( $payload ) );
            $outcome = mansu_online_attempt( $req );
            $result['key'] = $key;
            if ( is_wp_error( $outcome ) ) {
                $result['error'] = $outcome->get_error_code();
                $row = mansu_online_row( $key );
                $result['state'] = $row['state'] ?? 'not-claimed';
                $result['orderId'] = isset( $row['order_id'] ) ? (int) $row['order_id'] : null;
            } else {
                $result['success'] = $outcome['state'] === 'reserved' &&
                    $outcome['reservationVerified'] === true && $outcome['orderIdentityVerified'] === true;
                $result['state'] = $outcome['state'];
                $result['orderId'] = (int) $outcome['orderId'];
            }
        }
    } catch ( Throwable $error ) {
        $result['error'] = get_class( $error ); // Do not print secrets or stack traces.
        $result['state'] = 'rejected';
    }
    if ( file_put_contents( $dir . '/result-' . $side . '.json', wp_json_encode( $result ), LOCK_EX ) === false ) {
        throw new RuntimeException( 'Could not write original-order race result.' );
    }
    echo 'DISPOSABLE_RACE_WORKER_DONE ' . $side . PHP_EOL;
    return;
}
if ( $stage === 'verify' ) {
    if ( (int) wc_get_product( $fixture['ownerId'] )->get_stock_quantity() !== 1 ) {
        throw new RuntimeException( 'A hold incorrectly changed physical stock before payment.' );
    }
    $reserve = new \Automattic\WooCommerce\Checkout\Helpers\ReserveStock();
    $reserved = (int) $reserve->get_reserved_stock( wc_get_product( $fixture['productIds'][0] ) );
    if ( $reserved !== 1 ) {
        throw new RuntimeException( 'Two concurrent checkouts must leave exactly one hold; observed ' . $reserved );
    }
    global $wpdb;
    $count = (int) $wpdb->get_var( $wpdb->prepare(
        "SELECT COALESCE(SUM(stock_quantity),0) FROM {$wpdb->wc_reserved_stock} WHERE product_id=%d AND expires > UTC_TIMESTAMP()",
        $fixture['ownerId'] ) );
    if ( $count !== 1 ) { throw new RuntimeException( 'Duplicate MySQL stock owner hold: ' . $count ); }
    echo 'DISPOSABLE_RACE_VERIFY_OK' . PHP_EOL;
}
