<?php
/**
 * Disposable-only, synthetic website Paystack vs POS cash/payment race, plus
 * MySQL callback-lock timeout and same-reference retry conformance.
 */
if ( ! defined( 'WP_CLI' ) || ! WP_CLI ||
     ! defined( 'MANSU_CI_DISPOSABLE_WOO' ) || MANSU_CI_DISPOSABLE_WOO !== true ||
     wp_get_environment_type() !== 'local' ||
     get_option( 'blogname' ) !== 'Mansu isolated CI stock test' ||
     ! defined( 'MANSU_ONLINE_BRIDGE_SERVICE' ) || MANSU_ONLINE_BRIDGE_SERVICE !== 'staging' ||
     ! defined( 'WC_VERSION' ) || WC_VERSION !== '11.0.1' ||
     ! defined( 'WC_PAYSTACK_VERSION' ) || WC_PAYSTACK_VERSION !== '5.8.6' ||
     ! function_exists( 'mansu_online_attempt' ) ) {
    throw new RuntimeException( 'Cross-channel test refused outside disposable Woo/Paystack CI.' );
}
$phase = getenv( 'MANSU_CI_CROSS_PHASE' );
$kind = getenv( 'MANSU_CI_CROSS_KIND' ) ?: 'simple';
if ( ! in_array( $kind, array( 'simple', 'shared-parent' ), true ) ) {
    throw new RuntimeException( 'Unknown disposable stock-owner kind.' );
}
global $wpdb;
$assertions = 0;
$check = static function ( $ok, $why ) use ( &$assertions ) {
    ++$assertions;
    if ( ! $ok ) { throw new RuntimeException( $why ); }
};
$make_product = static function ( $suffix ) {
    $product = new WC_Product_Simple();
    $product->set_name( 'SYNTHETIC CROSS CHANNEL ' . $suffix );
    $product->set_status( 'publish' );
    $product->set_regular_price( '100.00' );
    $product->set_manage_stock( true );
    $product->set_stock_quantity( 1 );
    $product->set_backorders( 'no' );
    $product->set_sku( 'SYN-CROSS-' . wp_generate_uuid4() );
    $product->save();
    return $product;
};
$make_website = static function ( $product, $suffix ) use ( $check ) {
    $order = wc_create_order( array( 'status' => 'pending', 'created_via' => 'checkout' ) );
    $order->add_product( $product, 1 );
    $order->set_payment_method( 'paystack' );
    $order->set_billing_email( 'synthetic@example.invalid' );
    $order->calculate_totals( false );
    $ref = $order->get_id() . '_synthetic_cross_' . $suffix;
    $order->update_meta_data( '_paystack_txn_ref', $ref );
    $order->save();
    $reserve = new \Automattic\WooCommerce\Checkout\Helpers\ReserveStock();
    $reserve->reserve_stock_for_order( $order, 10 );
    $check( (int) $reserve->get_reserved_stock( $product ) === 1,
        'Could not create synthetic original website stock hold.' );
    return array( $order, $ref );
};
$notes = static function ( $order ) {
    return count( array_filter(
        wc_get_order_notes( array( 'order_id' => $order->get_id(), 'limit' => 100 ) ),
        static fn( $note ) => strpos( $note->content, 'Payment via Paystack successful' ) !== false
    ) );
};
if ( $phase === 'cross-setup' ) {
    // The cross-channel suite can run first and fail fast before the longer
    // signed webhook regression. No installed-site settings are consulted.
    update_option( 'woocommerce_paystack_settings', array(
        'enabled' => 'yes', 'testmode' => 'yes',
        'test_public_key' => 'pk_test_synthetic_ci_no_real_account',
        'test_secret_key' => 'sk_test_synthetic_ci_no_real_account',
        'payment_page' => 'redirect', 'autocomplete_order' => 'no',
        'saved_cards' => 'no',
    ) );
    if ( $kind === 'shared-parent' ) {
        $product = new WC_Product_Variable();
        $product->set_name( 'SYNTHETIC CROSS SHARED PARENT FINAL UNIT' );
        $product->set_status( 'publish' );
        $product->set_manage_stock( true );
        $product->set_stock_quantity( 1 );
        $product->set_backorders( 'no' );
        $product->save();
        $variations = array();
        foreach ( array( 'Size A', 'Size B' ) as $size ) {
            $variation = new WC_Product_Variation();
            $variation->set_parent_id( $product->get_id() );
            $variation->set_status( 'publish' );
            $variation->set_regular_price( '100.00' );
            $variation->set_manage_stock( false );
            $variation->set_sku( 'SYN-CROSS-' . wp_generate_uuid4() );
            $variation->save();
            $variations[] = $variation;
        }
        // WooCommerce stock-owner resolution for a child must be checked
        // from freshly hydrated product objects after persisting both
        // variation and parent records (as in the separate race workers).
        $website_item = wc_get_product( $variations[0]->get_id() );
        $pos_item = wc_get_product( $variations[1]->get_id() );
        $owner_a = $website_item ? (int) $website_item->get_stock_managed_by_id() : 0;
        $owner_b = $pos_item ? (int) $pos_item->get_stock_managed_by_id() : 0;
        $check( $owner_a === (int) $product->get_id() &&
            $owner_b === (int) $product->get_id(),
            'Different size variations failed to share original parent stock pool: ' .
            'parent=' . $product->get_id() . ' sizeA=' . $owner_a .
            ' sizeB=' . $owner_b );
    } else {
        $product = $make_product( 'last-item' );
        $website_item = $product;
        $pos_item = $product;
    }
    list( $website, $ref ) = $make_website( $website_item, 'late_vs_pos_cash_' . $kind );
    $expired = $wpdb->update( $wpdb->wc_reserved_stock,
        array( 'expires' => gmdate( 'Y-m-d H:i:s', time() - 30 ) ),
        array( 'order_id' => $website->get_id() ) );
    $check( $expired === 1, 'Could not expire synthetic website reservation.' );
    $key = wp_generate_uuid4();
    $payload = array(
        'service' => 'staging',
        'ledgerId' => MANSU_ONLINE_BRIDGE_LEDGER_ID,
        'key' => $key,
        'fingerprint' => str_repeat( 'c', 64 ),
        'cashierId' => '3c4e759e-cf64-4f8a-94bd-f978b737a985',
        'shiftId' => '39fda408-7303-42c5-bbdf-e89ed1eb4c5b',
        'saleType' => 'retail',
        'items' => array( array(
            'productId' => (int) $product->get_id(),
            'variationId' => $kind === 'shared-parent' ? (int) $pos_item->get_id() : 0,
            'quantity' => 1, 'expectedUnitCents' => 10000,
            'ownerId' => (int) $product->get_id(), 'sku' => $pos_item->get_sku(),
        ) ),
    );
    $req = new WP_REST_Request( 'POST', '/mansu-pos/v1/attempts' );
    $req->set_header( 'content-type', 'application/json' );
    $req->set_body( wp_json_encode( $payload ) );
    $reserved = mansu_online_attempt( $req );
    $check( ! is_wp_error( $reserved ) && $reserved['state'] === 'reserved' &&
        $reserved['reservationVerified'] === true, 'POS did not claim the last unit after web hold expiry.' );
    $cash_req = new WP_REST_Request( 'POST', '/mansu-pos/v1/attempts/' . $key . '/cash-intent' );
    $cash_req->set_param( 'key', $key );
    $cash_req->set_header( 'content-type', 'application/json' );
    $cash_req->set_body( '{}' );
    $intent = mansu_online_cash_intent( $cash_req );
    $check( ! is_wp_error( $intent ) && $intent['state'] === 'cash_intent' &&
        $intent['cashIntentVerified'] === true,
        'POS cash-intent was not durably recorded: ' .
        ( is_wp_error( $intent ) ? $intent->get_error_code() : wp_json_encode( $intent ) ) );
    $dir = WP_CONTENT_DIR . '/mansu-ci-cross-payment';
    $check( is_dir( $dir ) || wp_mkdir_p( $dir ),
        'Could not prepare synthetic cross-channel barrier.' );
    // The same disposable DB runs both variants sequentially. Never accept
    // a previous race's marker as proof of a second simultaneous admission.
    foreach ( array( 'website', 'pos' ) as $marker ) {
        if ( is_file( $dir . '/' . $marker ) && ! unlink( $dir . '/' . $marker ) ) {
            throw new RuntimeException( 'Could not reset previous synthetic race marker.' );
        }
    }
    $data = array( 'websiteId' => $website->get_id(),
        'posId' => (int) $reserved['orderId'], 'productId' => $product->get_id(),
        'websiteVariationId' => $kind === 'shared-parent' ? (int) $website_item->get_id() : 0,
        'posVariationId' => $kind === 'shared-parent' ? (int) $pos_item->get_id() : 0,
        'kind' => $kind, 'ref' => $ref, 'posKey' => $key );
    update_option( 'mansu_ci_cross_payment', $data, false );
    $fixtures = get_option( 'mansu_ci_paystack_http_cases', array() );
    $fixtures['cross_paid_late'] = array( 'id' => $website->get_id(),
        'product' => $product->get_id(), 'ref' => $ref, 'mode' => 'exact' );
    update_option( 'mansu_ci_paystack_http_cases', $fixtures, false );
    echo 'DISPOSABLE_CROSS_SETUP ' . wp_json_encode( $data ) . PHP_EOL;
    return;
}
$data = get_option( 'mansu_ci_cross_payment', array() );
if ( $phase === 'cross-pos-pay' ) {
    $check( isset( $data['posKey'], $data['posId'] ), 'Missing synthetic POS cash attempt.' );
    $request = new WP_REST_Request( 'POST', '/mansu-pos/v1/attempts/' . $data['posKey'] . '/pay' );
    $request->set_param( 'key', $data['posKey'] );
    $request->set_header( 'content-type', 'application/json' );
    $request->set_body( '{}' );
    $outcome = mansu_online_pay( $request );
    $check( ! is_wp_error( $outcome ) && $outcome['paymentVerified'] === true,
        'POS payment failed after simultaneously competing web callback: ' .
        ( is_wp_error( $outcome ) ? $outcome->get_error_code() : wp_json_encode( $outcome ) ) );
    echo 'DISPOSABLE_CROSS_POS_PAID_OK ' . $assertions . ' assertions' . PHP_EOL;
    return;
}
if ( $phase === 'cross-verify' ) {
    $check( isset( $data['posId'], $data['websiteId'], $data['productId'], $data['posKey'] ),
        'Missing cross-channel evidence.' );
    $pos = wc_get_order( $data['posId'] );
    $web = wc_get_order( $data['websiteId'] );
    $product = wc_get_product( $data['productId'] );
    $pos_items = $pos->get_items( 'line_item' );
    $web_items = $web->get_items( 'line_item' );
    $pos_line = current( $pos_items );
    $web_line = current( $web_items );
    $check( $pos->is_paid() && (bool) $pos->get_date_paid() &&
        (int) $pos_line->get_meta( '_reduced_stock', true ) === 1,
        'POS cash was not the single physically paid stock owner.' );
    $check( $web->has_status( 'on-hold' ) &&
        $web->get_meta( '_mansu_website_stock_review', true ) === 'required' &&
        ! $web->get_date_paid() && (int) $web_line->get_meta( '_reduced_stock', true ) === 0,
        'Expired website Paystack callback claimed the stock or lost human review.' );
    $check( (int) $product->get_stock_quantity() === 0,
        'POS+website race oversold the final synthetic unit: ' . $product->get_stock_quantity() );
    $check( $notes( $web ) === 1,
        'Cross-channel race produced duplicate external Paystack success notes.' );
    if ( $kind === 'shared-parent' ) {
        $check( $data['kind'] === 'shared-parent' &&
            (int) $data['websiteVariationId'] > 0 &&
            (int) $data['posVariationId'] > 0 &&
            (int) $data['websiteVariationId'] !== (int) $data['posVariationId'] &&
            (int) $web_line->get_variation_id() === (int) $data['websiteVariationId'] &&
            (int) $pos_line->get_variation_id() === (int) $data['posVariationId'],
            'The website and POS did not purchase different variants of one parent stock pool.' );
        $website_variant = wc_get_product( $data['websiteVariationId'] );
        $pos_variant = wc_get_product( $data['posVariationId'] );
        $check( $website_variant && $pos_variant &&
            (int) $website_variant->get_stock_managed_by_id() === (int) $product->get_id() &&
            (int) $pos_variant->get_stock_managed_by_id() === (int) $product->get_id(),
            'Shared parent stock owner was changed or fragmented during simultaneous payment.' );
    }
    $dir = WP_CONTENT_DIR . '/mansu-ci-cross-payment';
    $check( is_file( $dir . '/pos' ) && is_file( $dir . '/website' ),
        'Both payment channels did not meet the same original-item barrier.' );
    $row = mansu_online_row( $data['posKey'] );
    $check( $row && $row['state'] === 'paid' &&
        mansu_online_order_view( $row )['paymentVerified'] === true,
        'POS original payment/ledger evidence was not recovered after race.' );
    echo 'DISPOSABLE_CROSS_CHANNEL_PAID_RACE_OK ' . $assertions .
        ' assertions; one stock owner, late external payment for human review.' . PHP_EOL;
    return;
}
if ( $phase === 'lock-setup' ) {
    $product = $make_product( 'lock-retry' );
    list( $order, $ref ) = $make_website( $product, 'locked_then_retry' );
    $dir = WP_CONTENT_DIR . '/mansu-ci-paystack-lock';
    $check( ! is_dir( $dir ) && wp_mkdir_p( $dir ), 'Could not create synthetic lock test.' );
    $entry = array( 'id' => $order->get_id(), 'ref' => $ref,
        'product' => $product->get_id(), 'mode' => 'exact' );
    $fixtures = get_option( 'mansu_ci_paystack_http_cases', array() );
    $fixtures['lock_timeout'] = $entry;
    update_option( 'mansu_ci_paystack_http_cases', $fixtures, false );
    update_option( 'mansu_ci_cross_lock', $entry, false );
    echo 'DISPOSABLE_LOCK_SETUP ' . wp_json_encode( $entry ) . PHP_EOL;
    return;
}
$lock = get_option( 'mansu_ci_cross_lock', array() );
if ( $phase === 'lock-hold' ) {
    $check( isset( $lock['id'] ), 'No isolated Paystack lock target.' );
    $name = 'mansu-paystack-order-' . (int) $lock['id'];
    $taken = $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, %d)', $name, 5 ) );
    $check( (string) $taken === '1', 'Test could not acquire real MySQL advisory lock.' );
    $dir = WP_CONTENT_DIR . '/mansu-ci-paystack-lock';
    $check( file_put_contents( $dir . '/held', (string) getmypid(), LOCK_EX ) !== false,
        'Could not signal held synthetic advisory lock.' );
    $deadline = microtime( true ) + 65;
    while ( ! is_file( $dir . '/release' ) && microtime( true ) < $deadline ) { usleep( 100000 ); }
    $released = $wpdb->get_var( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $name ) );
    $check( (string) $released === '1', 'Could not release isolated advisory lock.' );
    echo 'DISPOSABLE_LOCK_HOLDER_RELEASED_OK' . PHP_EOL;
    return;
}
if ( in_array( $phase, array( 'lock-timeout-verify', 'lock-recovered-verify' ), true ) ) {
    $check( isset( $lock['id'], $lock['product'] ), 'Missing synthetic lock order.' );
    $order = wc_get_order( $lock['id'] );
    $product = wc_get_product( $lock['product'] );
    $line_items = $order->get_items( 'line_item' );
    $line = current( $line_items );
    if ( $phase === 'lock-timeout-verify' ) {
        $check( $order->has_status( 'pending' ) &&
            ! $order->get_date_paid() &&
            $order->get_meta( '_mansu_website_stock_review', true ) !== 'required' &&
            (int) $product->get_stock_quantity() === 1 &&
            (int) $line->get_meta( '_reduced_stock', true ) === 0 &&
            $notes( $order ) === 0,
            'Advisory-lock timeout incorrectly mutated an unpaid original Woo order.' );
        echo 'DISPOSABLE_PAYSTACK_LOCK_TIMEOUT_OK ' . $assertions . ' assertions' . PHP_EOL;
    } else {
        $check( $order->is_paid() && $order->get_date_paid() &&
            (int) $product->get_stock_quantity() === 0 &&
            (int) $line->get_meta( '_reduced_stock', true ) === 1 &&
            $notes( $order ) === 1,
            'Same-reference callback retry did not safely complete the original held order.' );
        echo 'DISPOSABLE_PAYSTACK_LOCK_RETRY_OK ' . $assertions . ' assertions' . PHP_EOL;
    }
    return;
}
throw new RuntimeException( 'Unknown disposable cross-channel phase.' );
