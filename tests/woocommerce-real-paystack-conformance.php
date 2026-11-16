<?php
/**
 * REAL Paystack for WooCommerce gateway v5.8.6 + pinned Woo stock hooks.
 * Disposable GitHub Actions MySQL test ONLY. Synthetic HTTP response, no Paystack
 * account, credentials, settlement, customer or merchant website involved.
 *
 * A gateway returning success after WC_Order::payment_complete() was rejected
 * is a KNOWN UNRESOLVED monetary/UX mismatch: these tests document it, rather
 * than falsely treating this as production acceptance.
 */
if ( ! defined( 'WP_CLI' ) || ! WP_CLI ||
     ! defined( 'MANSU_CI_DISPOSABLE_WOO' ) || MANSU_CI_DISPOSABLE_WOO !== true ||
     wp_get_environment_type() !== 'local' ||
     ! defined( 'MANSU_ONLINE_BRIDGE_SERVICE' ) || MANSU_ONLINE_BRIDGE_SERVICE !== 'staging' ||
     get_option( 'blogname' ) !== 'Mansu isolated CI stock test' ) {
    throw new RuntimeException( 'Refusing Paystack conformance test outside disposable CI.' );
}
if ( ! defined( 'WC_PAYSTACK_VERSION' ) || WC_PAYSTACK_VERSION !== '5.8.6' ||
     ! class_exists( 'WC_Gateway_Paystack' ) ||
     ! function_exists( 'mansu_online_website_hold_safe' ) ) {
    throw new RuntimeException( 'Pinned actual Paystack 5.8.6 plugin or Mansu quarantine is unavailable.' );
}
$paystack_checks = 0;
$paystack_assert = static function ( $ok, $message ) use ( &$paystack_checks ) {
    ++$paystack_checks;
    if ( ! $ok ) { throw new RuntimeException( $message ); }
};
$paystack_assert( WC_VERSION === MANSU_ONLINE_PINNED_WOO && get_woocommerce_currency() === 'GHS',
    'Disposable Woo version or GHS currency is not pinned.' );

if ( ! WC()->cart ) { WC()->cart = new WC_Cart(); }
$gateway = new WC_Gateway_Paystack();
$gateway->secret_key = 'sk_test_disposable_fixture_not_a_real_key';
// Owner reports saved-payment cards ENABLED on the real WooCommerce site.
// Keep this disposable direct-token fixture aligned with that option. This
// still does not exercise a real merchant token, Paystack settlement or
// every checkout entry point and is NOT production acceptance.
$gateway->saved_cards = true;
$paystack_assert( $gateway->saved_cards === true,
    'Saved-card gateway test must match the owner-reported live configuration.' );
$paystack_assert( has_filter( 'pre_http_request', 'mansu_online_paystack_saved_token_precharge' ) === 1,
    'Pinned Paystack precharge HTTP filter was not registered in native Woo.' );
$paystack_mode = 'exact';
$synthetic_http_calls = 0;
$http_mock = static function ( $preempt, $args, $url ) use ( &$paystack_mode, &$synthetic_http_calls ) {
    // A previously refused charge MUST remain refused. WP_Http filters run
    // sequentially; accidentally replacing our earlier WP_Error with a fake
    // Paystack success would make this conformance test dangerously misleading.
    if ( $preempt !== false ) { return $preempt; }
    // Never make any Paystack network call, including from a newly added path.
    if ( strpos( $url, 'api.paystack.co/' ) === false ) { return $preempt; }
    if ( $url !== 'https://api.paystack.co/transaction/charge_authorization' ||
         strtoupper( $args['method'] ?? '' ) !== 'POST' ) {
        return new WP_Error( 'ci_paystack_network_blocked', 'Unmocked Paystack route refused.' );
    }
    $payload = json_decode( $args['body'] ?? '', true );
    if ( ! is_array( $payload ) || ! isset( $payload['reference'], $payload['amount'] ) ) {
        throw new RuntimeException( 'Paystack test could not inspect outgoing synthetic token charge.' );
    }
    ++$synthetic_http_calls;
    $paid_cents = $paystack_mode === 'underpaid' ? $payload['amount'] - 100 : $payload['amount'];
    return array(
        'headers' => array(),
        'response' => array( 'code' => 200, 'message' => 'OK' ),
        'body' => wp_json_encode( array(
            'status' => true,
            'data' => array(
                'status' => 'success',
                'reference' => $payload['reference'],
                'amount' => $paid_cents,
                'currency' => $paystack_mode === 'wrong-currency' ? 'NGN' : 'GHS',
            ),
        ) ),
        'cookies' => array(),
        'filename' => null,
    );
};
add_filter( 'pre_http_request', $http_mock, 10, 3 );
$reserve = new \Automattic\WooCommerce\Checkout\Helpers\ReserveStock();
global $wpdb;

$make_website_case = static function ( $created_via, $expired ) use ( $reserve, $wpdb, $paystack_assert ) {
    $product = new WC_Product_Simple();
    $product->set_name( 'SYNTHETIC PAYSTACK TEST ONLY' );
    $product->set_status( 'publish' );
    $product->set_regular_price( '100.00' );
    $product->set_manage_stock( true );
    $product->set_stock_quantity( 1 );
    $product->set_backorders( 'no' );
    $product->set_sku( 'CI-PAYSTACK-' . wp_generate_uuid4() );
    $product->save();
    $order = wc_create_order( array( 'status' => 'pending', 'created_via' => $created_via ) );
    $order->add_product( $product, 1 );
    $order->set_payment_method( 'paystack' );
    $order->set_billing_email( 'synthetic@example.invalid' );
    $order->calculate_totals( false );
    $order->save();
    $reserve->reserve_stock_for_order( $order, 10 );
    $paystack_assert( (int) $reserve->get_reserved_stock( $product ) === 1,
        'Actual Woo website hold was not created.' );
    if ( $expired ) {
        $changed = $wpdb->update( $wpdb->wc_reserved_stock,
            array( 'expires' => gmdate( 'Y-m-d H:i:s', time() - 30 ) ),
            array( 'order_id' => $order->get_id() ) );
        $paystack_assert( $changed === 1, 'Synthetic Paystack website reservation did not expire.' );
        // Model a completed competing last-unit POS sale without calling any
        // merchant API. The earlier real race suite separately verifies POS
        // reservations, payments and order recovery against native Woo.
        wc_update_product_stock( $product, 0, 'set' );
        $paystack_assert( (int) wc_get_product( $product->get_id() )->get_stock_quantity() === 0,
            'Synthetic competing sale did not claim last unit.' );
    }
    return array( $order->get_id(), $product->get_id() );
};
$exercise = static function ( $via, $mode, $expired ) use (
    &$paystack_mode, &$synthetic_http_calls, $make_website_case, $gateway, $paystack_assert
) {
    $paystack_mode = $mode;
    list( $order_id, $product_id ) = $make_website_case( $via, $expired );
    // The public webhook/return entry point must reject the expired original
    // Woo reservation BEFORE running the upstream gateway success path.
    // This exercises the same hold-admission predicate used under its DB lock,
    // on both classic checkout and Store API, without real Paystack credentials.
    $entry_safe = mansu_online_paystack_original_hold_safe( wc_get_order( $order_id ) );
    $paystack_assert( $entry_safe === ! $expired,
        'Paystack entry would admit an expired hold or reject a valid original hold.' );
    if ( ! $expired ) {
        // A still-present hold that expires during gateway verification is
        // not sufficiently safe for admission. Force it near expiry, then
        // restore its original duration without changing Woo stock counts.
        global $wpdb;
        $near = $wpdb->update( $wpdb->wc_reserved_stock,
            array( 'expires' => gmdate( 'Y-m-d H:i:s', time() + 45 ) ),
            array( 'order_id' => $order_id ) );
        $paystack_assert( $near === 1 &&
            mansu_online_paystack_original_hold_safe( wc_get_order( $order_id ) ) === false,
            'Paystack entry admitted a near-expiry hold inside its verification margin.' );
        // This is the actual gateway 5.8.6 token method, not a copied
        // reconstruction. An unsafe hold MUST block BEFORE its outbound
        // Paystack charge_authorization request reaches the CI HTTP stub.
        $before = $synthetic_http_calls;
        $near_charge = $gateway->process_token_payment(
            'synthetic_authorization###synthetic@example.invalid', $order_id );
        $paystack_assert( ! $near_charge && $synthetic_http_calls === $before,
            'Saved-card near-expiry charge reached Paystack or appeared successful: return=' .
            get_debug_type( $near_charge ) . '; calls=' . $before . '/' . $synthetic_http_calls );
        $reset = $wpdb->update( $wpdb->wc_reserved_stock,
            array( 'expires' => gmdate( 'Y-m-d H:i:s', time() + 600 ) ),
            array( 'order_id' => $order_id ) );
        $paystack_assert( $reset === 1 &&
            mansu_online_paystack_original_hold_safe( wc_get_order( $order_id ) ) === true,
            'Valid original hold did not recover after fixture expiry reset.' );
    }
    $verified = wc_get_order( $order_id );
    $charge = array( 'reference' => (string) $verified->get_meta( '_paystack_txn_ref', true ),
        'amount' => (int) round( (float) $verified->get_total() * 100 ),
        'currency' => $verified->get_currency() );
    if ( ! $expired ) {
        $paystack_assert( mansu_online_paystack_token_charge_matches( $verified, $charge ),
            'Valid Paystack token payload was not admitted under original Woo stock hold.' );
        $wrong_amount = $charge;
        $wrong_amount['amount'] += 100;
        $wrong_currency = $charge;
        $wrong_currency['currency'] = 'NGN';
        $wrong_reference = $charge;
        $wrong_reference['reference'] .= '_tampered';
        $paystack_assert(
            ! mansu_online_paystack_token_charge_matches( $verified, $wrong_amount ) &&
            ! mansu_online_paystack_token_charge_matches( $verified, $wrong_currency ) &&
            ! mansu_online_paystack_token_charge_matches( $verified, $wrong_reference ),
            'Paystack token precharge allowed changed amount, currency or reference.' );
    } else {
        // Real website stock is already claimed by a competing POS purchase.
        // An ordinary saved-card retry must fail with ZERO network charge
        // attempts and no claim that external money was actually received.
        $before = $synthetic_http_calls;
        $blocked_charge = $gateway->process_token_payment(
            'synthetic_authorization###synthetic@example.invalid', $order_id );
        $blocked_order = wc_get_order( $order_id );
        $paystack_assert( ! $blocked_charge &&
            $synthetic_http_calls === $before &&
            $blocked_order->has_status( 'pending' ) &&
            $blocked_order->get_meta( '_mansu_website_stock_review', true ) !== 'required',
            'Expired saved-card charge was sent to Paystack or marked externally paid.' );
        // A separate fixture must STILL prove postcharge quarantine if an
        // already-settled success bypassed the outbound admission boundary,
        // e.g. gateway callbacks, code drift or payment settlement delay.
        // This bypass is ONLY in disposable CI; the production filter stays.
        $paystack_assert( remove_filter( 'pre_http_request',
            'mansu_online_paystack_saved_token_precharge', 1 ),
            'Disposable fixture could not isolate the postcharge recovery branch.' );
    }
    try {
        $reported_success = $gateway->process_token_payment(
            'synthetic_authorization###synthetic@example.invalid', $order_id );
    } finally {
        if ( $expired ) {
            add_filter( 'pre_http_request', 'mansu_online_paystack_saved_token_precharge', 1, 3 );
        }
    }
    $order = wc_get_order( $order_id );
    $product = wc_get_product( $product_id );
    $line = current( $order->get_items( 'line_item' ) );
    $reduced = $line ? (int) $line->get_meta( '_reduced_stock', true ) : 0;
    $paystack_assert( $reported_success === true, 'Real Paystack token path did not reach synthetic success branch.' );
    return array( $order, $product, $reduced );
};

// Valid website checkout (both classic and Store API) still completes once.
foreach ( array( 'checkout', 'store-api' ) as $via ) {
    list( $order, $product, $reduced ) = $exercise( $via, 'exact', false );
    $paystack_assert( $order->is_paid() && $order->get_date_paid() &&
        $order->get_meta( '_mansu_website_stock_review', true ) !== 'required' &&
        (int) $product->get_stock_quantity() === 0 && $reduced === 1,
        'Real Paystack valid payment did not complete and reduce its held stock exactly once.' );
    // Paystack 5.8.6 can invoke process_token_payment again on a previous
    // order. Once Woo has completed the first payment, a saved-card retry must
    // never reach its external charge_authorization endpoint a second time.
    $calls_before_retry = $synthetic_http_calls;
    $repeat = $gateway->process_token_payment(
        'synthetic_authorization###synthetic@example.invalid', $order->get_id() );
    $repeat_order = wc_get_order( $order->get_id() );
    $paystack_assert( ! $repeat && $synthetic_http_calls === $calls_before_retry &&
        $repeat_order->is_paid() &&
        (int) wc_get_product( $product->get_id() )->get_stock_quantity() === 0,
        'Already-paid saved-card retry caused a second gateway charge or changed stock.' );
}

// Paystack may return true even when Woo rejects a late payment_complete().
// That is NOT an approval to ship or a proof that the charge was reversed.
list( $order, $product, $reduced ) = $exercise( 'store-api', 'exact', true );
$paystack_assert( $order->has_status( 'on-hold' ) && ! $order->get_date_paid() &&
    $order->get_meta( '_mansu_website_stock_review', true ) === 'required' &&
    (int) $product->get_stock_quantity() === 0 && $reduced === 0,
    'Real Paystack late token callback consumed POS-sold stock or escaped quarantine.' );

// A successful but underpaid Paystack transaction uses update_status(on-hold)
// rather than payment_complete() or wc_reduce_stock_levels().
list( $order, $product, $reduced ) = $exercise( 'checkout', 'underpaid', true );
$paystack_assert( $order->has_status( 'on-hold' ) &&
    $order->get_meta( '_mansu_website_stock_review', true ) === 'required' &&
    (int) $product->get_stock_quantity() === 0 && $reduced === 0,
    'Real Paystack short-paid on-hold path lost expired-hold review evidence.' );

// Wrong-currency successful Paystack transactions call the Woo stock reducer
// directly, without normal payment_complete() admission.
list( $order, $product, $reduced ) = $exercise( 'store-api', 'wrong-currency', true );
$paystack_assert( $order->has_status( 'on-hold' ) &&
    $order->get_meta( '_mansu_website_stock_review', true ) === 'required' &&
    (int) $product->get_stock_quantity() === 0 && $reduced === 0,
    'Real Paystack currency-mismatch path state: status=' . $order->get_status() .
    ' review=' . $order->get_meta( '_mansu_website_stock_review', true ) .
    ' stock=' . $product->get_stock_quantity() . ' line_reduced=' . $reduced );
$paystack_assert( $synthetic_http_calls === 5,
    'Expected five entirely synthetic real-gateway token payment HTTP stubs.' );
remove_filter( 'pre_http_request', $http_mock, 10 );

echo 'DISPOSABLE_PAYSTACK_GATEWAY_PATHS_OK ' . $paystack_checks .
    ' assertions; REAL upstream Paystack v5.8.6 token-charge path, synthetic HTTP only.' . PHP_EOL;
echo 'PAYSTACK_PRECHARGE_GUARD_OK: enabled saved cards block expired/near-expiry charge_authorization BEFORE network calls; amount/currency/reference checked.' . PHP_EOL;
echo 'PAYSTACK_RELEASE_BLOCKED: intentionally bypassed postcharge settlement still demonstrates gateway success/failed Woo completion; redirects, refunds, installed PHP/HPOS and real settlement remain unverified.' . PHP_EOL;
