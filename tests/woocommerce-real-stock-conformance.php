<?php
/**
 * Disposable WordPress + real WooCommerce reservation conformance exercise.
 * Run only using WP-CLI in a fresh GitHub Actions MySQL database.
 * Never run against mansutrendzgh.com, its inventory, or an existing store.
 */
if ( ! defined( 'WP_CLI' ) || ! WP_CLI || wp_get_environment_type() !== 'local' ||
     MANSU_ONLINE_BRIDGE_SERVICE !== 'staging' || ! defined( 'MANSU_CI_DISPOSABLE_WOO' ) ||
     MANSU_CI_DISPOSABLE_WOO !== true || get_option( 'blogname' ) !== 'Mansu isolated CI stock test' ) {
    throw new RuntimeException( 'Disposable WP-CLI fixture identity is not verified; refusing to test.' );
}
if ( ! function_exists( 'mansu_online_attempt' ) || ! class_exists( '\Automattic\WooCommerce\Checkout\Helpers\ReserveStock' ) ) {
    throw new RuntimeException( 'The local managed-stock bridge or Woo checkout reserve class is missing.' );
}

$checks = 0;
$assert = static function ( $condition, $message ) use ( &$checks ) {
    ++$checks;
    if ( ! $condition ) { throw new RuntimeException( $message ); }
};
$assert( WC_VERSION === MANSU_ONLINE_PINNED_WOO, 'Running an unpinned Woo version.' );
$assert( ! is_wp_error( mansu_online_ready() ), 'Woo version, schema, stock, or MySQL engine prerequisites failed.' );
$assert( get_woocommerce_currency() === 'GHS', 'Synthetic Woo test currency changed.' );

$make_simple = static function () {
    $product = new WC_Product_Simple();
    $product->set_name( 'SYNTHETIC POS LAST UNIT' );
    $product->set_status( 'publish' );
    $product->set_regular_price( '100.00' );
    $product->set_manage_stock( true );
    $product->set_stock_quantity( 1 );
    $product->set_backorders( 'no' );
    $product->set_sku( 'SYNTHETIC-LAST-UNIT-' . wp_generate_uuid4() );
    $product->save();
    return wc_get_product( $product->get_id() );
};
$make_variations = static function () {
    $parent = new WC_Product_Variable();
    $parent->set_name( 'SYNTHETIC SHARED PARENT STOCK' );
    $parent->set_status( 'publish' );
    $parent->set_manage_stock( true );
    $parent->set_stock_quantity( 1 );
    $parent->set_backorders( 'no' );
    $parent->save();
    $children = array();
    foreach ( array( 'RED', 'BLUE' ) as $label ) {
        $variation = new WC_Product_Variation();
        $variation->set_parent_id( $parent->get_id() );
        $variation->set_status( 'publish' );
        $variation->set_regular_price( '100.00' );
        $variation->set_manage_stock( false );
        $variation->set_sku( 'SYNTHETIC-SHARED-' . $label );
        $variation->save();
        $children[] = wc_get_product( $variation->get_id() );
    }
    return array( wc_get_product( $parent->get_id() ), $children );
};
$website_hold = static function ( $product ) {
    $order = wc_create_order( array( 'status' => 'pending', 'created_via' => 'checkout' ) );
    $order->add_product( $product, 1 );
    $order->calculate_totals( false );
    $order->save();
    $stock = new \Automattic\WooCommerce\Checkout\Helpers\ReserveStock();
    $stock->reserve_stock_for_order( $order, 10 );
    return $order;
};
$attempt = static function ( $product, $key, $parent_id = 0 ) {
    $parent_id = $parent_id ?: $product->get_id();
    $data = array(
        'service' => 'staging', 'ledgerId' => MANSU_ONLINE_BRIDGE_LEDGER_ID,
        'key' => $key, 'fingerprint' => str_repeat( 'a', 64 ),
        'cashierId' => '3c4e759e-cf64-4f8a-94bd-f978b737a985',
        'shiftId' => '39fda408-7303-42c5-bbdf-e89ed1eb4c5b',
        'saleType' => 'retail',
        'items' => array( array(
            'productId' => $parent_id,
            'variationId' => $parent_id === $product->get_id() ? 0 : $product->get_id(),
            'quantity' => 1, 'expectedUnitCents' => 10000,
            'ownerId' => (int) $product->get_stock_managed_by_id(),
            'sku' => $product->get_sku(),
        ) ),
    );
    $request = new WP_REST_Request( 'POST', '/mansu-pos/v1/attempts' );
    $request->set_header( 'content-type', 'application/json' );
    $request->set_body( wp_json_encode( $data ) );
    return mansu_online_attempt( $request );
};

// 1. A real Woo website checkout hold must block a POS claim on the same unit.
$simple = $make_simple();
$assert( (int) $simple->get_stock_quantity() === 1, 'Synthetic simple stock was not created.' );
$website = $website_hold( $simple );
$reserve = new \Automattic\WooCommerce\Checkout\Helpers\ReserveStock();
$assert( (int) $reserve->get_reserved_stock( $simple ) === 1, 'Woo checkout did not hold the final unit.' );
$key_blocked = '5ab6c00f-64e8-48d6-bad0-1e9cc8241bd1';
$blocked = $attempt( $simple, $key_blocked );
$assert( is_wp_error( $blocked ), 'POS oversold a website-held last unit.' );
$mapping = mansu_online_row( $key_blocked );
$assert( $mapping && $mapping['state'] === 'needs_review' && (int) $mapping['order_id'] > 0,
    'Failed POS order was not quarantined by original key.' );
$assert( (int) $simple->get_stock_quantity() === 1 &&
    (int) $reserve->get_reserved_stock( $simple ) === 1,
    'Rejected POS attempt changed existing website stock or hold.' );

// 2. Once website releases its hold, POS can claim the final unit; another
// website checkout is then refused by the exact same Woo core lock.
wc_release_stock_for_order( $website );
$assert( (int) $reserve->get_reserved_stock( $simple ) === 0, 'Woo did not release the website hold.' );
$key_pos = '4d8881d6-d6c5-4a48-8f96-1918b08f0cec';
$accepted = $attempt( $simple, $key_pos );
$assert( ! is_wp_error( $accepted ) && $accepted['state'] === 'reserved' &&
    $accepted['reservationVerified'] && $accepted['orderIdentityVerified'], 'Woo did not verify POS hold.' );
$assert( (int) $reserve->get_reserved_stock( $simple ) === 1,
    'POS reservation did not block the shared Woo stock pool.' );
$second_web = wc_create_order( array( 'status' => 'pending', 'created_via' => 'checkout' ) );
$second_web->add_product( $simple, 1 );
$second_web->calculate_totals( false );
$second_web->save();
$website_rejected = false;
try { $reserve->reserve_stock_for_order( $second_web, 10 ); }
catch ( Throwable $error ) { $website_rejected = true; }
$assert( $website_rejected && (int) $reserve->get_reserved_stock( $simple ) === 1,
    'Website checkout overrode the final POS-held unit.' );
$assert( (int) $simple->get_stock_quantity() === 1,
    'Reserving Woo stock incorrectly reduced on-hand stock before payment.' );

// 3. Parent-managed stock: variation RED held by POS blocks website BLUE.
list( $parent, $children ) = $make_variations();
$assert( (int) $children[0]->get_stock_managed_by_id() === $parent->get_id() &&
    (int) $children[1]->get_stock_managed_by_id() === $parent->get_id(),
    'Woo variations do not share the expected parent-managed stock.' );
$key_variant = '1ab1bd45-cc41-40bd-9f6a-2fd79a92765d';
$variant = $attempt( $children[0], $key_variant, $parent->get_id() );
$assert( ! is_wp_error( $variant ) && $variant['reservationVerified'] &&
    $variant['items'][0]['ownerId'] === $parent->get_id(),
    'POS variation did not hold the correct parent stock owner.' );
$assert( (int) $reserve->get_reserved_stock( $children[1] ) === 1,
    'Woo could not observe RED variation hold from BLUE.' );
$web_blue = wc_create_order( array( 'status' => 'pending', 'created_via' => 'checkout' ) );
$web_blue->add_product( $children[1], 1 );
$web_blue->calculate_totals( false );
$web_blue->save();
$blue_rejected = false;
try { $reserve->reserve_stock_for_order( $web_blue, 10 ); }
catch ( Throwable $error ) { $blue_rejected = true; }
$assert( $blue_rejected, 'Website BLUE variation oversold POS-held RED parent stock.' );
$assert( (int) $parent->get_stock_quantity() === 1,
    'Parent on-hand stock changed before payment.' );

// 4. Complete the ORIGINAL POS cash-intent/payment flow using real Woo order
// and stock hooks. There is no physical cash or external gateway in CI.
$cash_request = static function ( $key, $operation ) {
    $request = new WP_REST_Request( 'POST', '/mansu-pos/v1/attempts/' . $key . '/' . $operation );
    $request->set_param( 'key', $key );
    $request->set_header( 'content-type', 'application/json' );
    $request->set_body( '{}' );
    return $request;
};
$intent_request = $cash_request( $key_pos, 'cash-intent' );
$cash_intent = mansu_online_cash_intent( $intent_request );
$assert( ! is_wp_error( $cash_intent ) && $cash_intent['state'] === 'cash_intent' &&
    $cash_intent['cashIntentVerified'] && ! $cash_intent['paymentVerified'],
    'Woo did not durably acknowledge the original cash intent.' );
$assert( (int) $reserve->get_reserved_stock( $simple ) === 1 &&
    (int) wc_get_product( $simple->get_id() )->get_stock_quantity() === 1,
    'Acknowledging cash intent incorrectly changed website stock.' );
$pay_request = $cash_request( $key_pos, 'pay' );
$paid = mansu_online_pay( $pay_request );
$assert( ! is_wp_error( $paid ) && $paid['state'] === 'paid' &&
    $paid['paymentVerified'] && $paid['orderIdentityVerified'],
    'Real Woo payment, one-time stock reduction or paid identity was not verified.' );
$assert( (int) $reserve->get_reserved_stock( $simple ) === 0 &&
    (int) wc_get_product( $simple->get_id() )->get_stock_quantity() === 0,
    'Woo did not release original POS hold and deduct one physical stock unit.' );
$repeat_paid = mansu_online_pay( $pay_request );
$assert( ! is_wp_error( $repeat_paid ) && $repeat_paid['paymentVerified'] &&
    (int) wc_get_product( $simple->get_id() )->get_stock_quantity() === 0,
    'Same-key Woo payment replay deducted the same unit again.' );

// 5. Confirm that parent-managed variation cash completion deducts the
// SINGLE shared parent stock owner and cannot make BLUE independently sellable.
$variant_intent = mansu_online_cash_intent( $cash_request( $key_variant, 'cash-intent' ) );
$assert( ! is_wp_error( $variant_intent ) && $variant_intent['cashIntentVerified'],
    'Parent-managed variation cash intent was not verified.' );
$variant_paid = mansu_online_pay( $cash_request( $key_variant, 'pay' ) );
$assert( ! is_wp_error( $variant_paid ) && $variant_paid['paymentVerified'],
    'Parent-managed variation Woo payment was not verified.' );
$assert( (int) wc_get_product( $parent->get_id() )->get_stock_quantity() === 0 &&
    (int) $reserve->get_reserved_stock( $children[1] ) === 0,
    'Variation payment did not reduce the shared parent stock exactly once.' );
$assert( (int) wc_get_product( $parent->get_id() )->get_stock_quantity() === 0,
    'Parent stock was inadvertently replenished by failed website checkout.' );

// 6. A normal website checkout with a CURRENT native Woo hold must still
// complete. The PHP hook does not reject all legitimate online payments.
$current_product = $make_simple();
$current_web = $website_hold( $current_product );
$assert( $current_web->payment_complete() === true, 'Valid original website hold was denied.' );
$assert( (int) wc_get_product( $current_product->get_id() )->get_stock_quantity() === 0,
    'Valid website payment failed to deduct its original stock unit.' );
$assert( $current_web->get_meta( '_mansu_website_stock_review', true ) !== 'required',
    'Valid current website hold was incorrectly quarantined.' );

// 7. An EXPIRED website reservation whose order is already paid externally
// must NOT call stock reduction via Woo payment_complete(), even when the POS
// is holding the last unit. Actual gateway money remains a manual liability.
$late_product = $make_simple();
$old_web = $website_hold( $late_product );
global $wpdb;
$expired = $wpdb->update( $wpdb->wc_reserved_stock,
    array( 'expires' => gmdate( 'Y-m-d H:i:s', time() - 30 ) ),
    array( 'order_id' => $old_web->get_id() ) );
$assert( $expired === 1 && (int) $reserve->get_reserved_stock( $late_product ) === 0,
    'Expired website hold was not removed from available inventory.' );
$key_late = 'f51f460c-ebc8-48e3-8f63-9adf76ea0cd7';
$late_pos = $attempt( $late_product, $key_late );
$assert( ! is_wp_error( $late_pos ) && $late_pos['reservationVerified'],
    'POS could not reserve stock released by expired website checkout.' );
$late_intent = mansu_online_cash_intent( $cash_request( $key_late, 'cash-intent' ) );
$assert( ! is_wp_error( $late_intent ) && $late_intent['cashIntentVerified'],
    'POS original cash intent was not preserved during website hold expiry.' );
$assert( $old_web->payment_complete() === false,
    'Expired website gateway callback was incorrectly admitted as a paid Woo order.' );
$old_web = wc_get_order( $old_web->get_id() );
$assert( $old_web->has_status( 'on-hold' ) &&
    $old_web->get_meta( '_mansu_website_stock_review', true ) === 'required' &&
    ! $old_web->get_date_paid(), 'Unverified website gateway payment was not quarantined.' );
$assert( (int) wc_get_product( $late_product->get_id() )->get_stock_quantity() === 1,
    'Rejected late website payment changed Woo stock.' );
$late_pay = mansu_online_pay( $cash_request( $key_late, 'pay' ) );
$assert( ! is_wp_error( $late_pay ) && $late_pay['paymentVerified'] &&
    (int) wc_get_product( $late_product->get_id() )->get_stock_quantity() === 0,
    'Late website callback interfered with the original POS held unit.' );

// 8. Reverse ordering: POS pays first, then an expired website callback
// tries to claim that stock. There must be NO negative stock in native Woo.
$reverse_product = $make_simple();
$reverse_old_web = $website_hold( $reverse_product );
$reverse_expired = $wpdb->update( $wpdb->wc_reserved_stock,
    array( 'expires' => gmdate( 'Y-m-d H:i:s', time() - 30 ) ),
    array( 'order_id' => $reverse_old_web->get_id() ) );
$assert( $reverse_expired === 1, 'Reverse race setup did not expire the website hold.' );
$reverse_key = '11ec976f-dab3-4c75-b21e-27d318f315f0';
$reverse_pos = $attempt( $reverse_product, $reverse_key );
$assert( ! is_wp_error( $reverse_pos ) && $reverse_pos['reservationVerified'],
    'POS did not reserve the final unit after website expiry.' );
$reverse_intent = mansu_online_cash_intent( $cash_request( $reverse_key, 'cash-intent' ) );
$assert( ! is_wp_error( $reverse_intent ) && $reverse_intent['cashIntentVerified'],
    'Reverse race POS cash intent was not verified.' );
$reverse_paid = mansu_online_pay( $cash_request( $reverse_key, 'pay' ) );
$assert( ! is_wp_error( $reverse_paid ) && $reverse_paid['paymentVerified'] &&
    (int) wc_get_product( $reverse_product->get_id() )->get_stock_quantity() === 0,
    'Reverse race POS payment did not reduce once-only native stock.' );
$reverse_callback = $reverse_old_web->payment_complete();
$reverse_old_web = wc_get_order( $reverse_old_web->get_id() );
$assert( $reverse_callback === false &&
    $reverse_old_web->get_meta( '_mansu_website_stock_review', true ) === 'required',
    'Late gateway callback bypassed the website payment quarantine.' );
$assert( (int) wc_get_product( $reverse_product->get_id() )->get_stock_quantity() === 0,
    'Website callback after POS payment oversold the final unit.' );

// 9. A plugin bypassing payment_complete() by directly setting a paid
// status must still be denied the native stock-reduction hook, and it must
// not leave a contested order in the "processing" fulfilment queue.
$direct_product = $make_simple();
$direct_web = $website_hold( $direct_product );
$direct_expired = $wpdb->update( $wpdb->wc_reserved_stock,
    array( 'expires' => gmdate( 'Y-m-d H:i:s', time() - 30 ) ),
    array( 'order_id' => $direct_web->get_id() ) );
$assert( $direct_expired === 1, 'Direct-status bypass did not expire website hold.' );
$direct_key = 'a3e3e62e-6022-4239-af2e-c0ed0f413cb2';
$direct_pos = $attempt( $direct_product, $direct_key );
$assert( ! is_wp_error( $direct_pos ) && $direct_pos['reservationVerified'],
    'Direct-status bypass setup did not reserve remaining POS unit.' );
$direct_pos_intent = mansu_online_cash_intent( $cash_request( $direct_key, 'cash-intent' ) );
$direct_paid = mansu_online_pay( $cash_request( $direct_key, 'pay' ) );
$assert( ! is_wp_error( $direct_pos_intent ) && ! is_wp_error( $direct_paid ),
    'Direct-status bypass original POS payment was not confirmed.' );
$direct_web->update_status( 'processing', 'Synthetic gateway bypasses payment_complete.' );
$direct_web = wc_get_order( $direct_web->get_id() );
$assert( $direct_web->has_status( 'on-hold' ) &&
    $direct_web->get_meta( '_mansu_website_stock_review', true ) === 'required',
    'Direct paid status without a hold was not moved into manual review.' );
$assert( (int) wc_get_product( $direct_product->get_id() )->get_stock_quantity() === 0,
    'Direct paid-status gateway bypass reduced stock below zero.' );
// 10. Woo Checkout Block / Store API orders use "store-api", not "checkout".
// An original held Store API payment must succeed exactly once.
$block_product = $make_simple();
$block_held = wc_create_order( array( 'status' => 'pending', 'created_via' => 'store-api' ) );
$block_held->add_product( $block_product, 1 );
$block_held->calculate_totals( false );
$block_held->save();
$reserve->reserve_stock_for_order( $block_held, 10 );
$assert( $block_held->get_created_via() === 'store-api' &&
    (int) $reserve->get_reserved_stock( $block_product ) === 1,
    'Store API checkout did not create a real, active Woo stock hold.' );
$assert( $block_held->payment_complete() === true &&
    (int) wc_get_product( $block_product->get_id() )->get_stock_quantity() === 0,
    'Legitimate Store API checkout failed or counted stock twice.' );
$assert( $block_held->get_meta( '_mansu_website_stock_review', true ) !== 'required',
    'Healthy Store API website purchase was wrongly quarantined.' );

// 11. A delayed Store API payment after its original hold expires must NOT
// claim the last unit already sold in the POS, including late callback replay.
$block_late_product = $make_simple();
$block_late = wc_create_order( array( 'status' => 'pending', 'created_via' => 'store-api' ) );
$block_late->add_product( $block_late_product, 1 );
$block_late->calculate_totals( false );
$block_late->save();
$reserve->reserve_stock_for_order( $block_late, 10 );
$block_expired = $wpdb->update( $wpdb->wc_reserved_stock,
    array( 'expires' => gmdate( 'Y-m-d H:i:s', time() - 30 ) ),
    array( 'order_id' => $block_late->get_id() ) );
$assert( $block_expired === 1, 'Store API hold did not expire in synthetic exercise.' );
$block_key = 'f9c279d1-1d3c-4254-b876-569ae5d22173';
$block_pos = $attempt( $block_late_product, $block_key );
$assert( ! is_wp_error( $block_pos ) && $block_pos['reservationVerified'],
    'POS did not reserve Store API expired last unit.' );
$block_intent = mansu_online_cash_intent( $cash_request( $block_key, 'cash-intent' ) );
$block_paid = mansu_online_pay( $cash_request( $block_key, 'pay' ) );
$assert( ! is_wp_error( $block_intent ) && ! is_wp_error( $block_paid ) &&
    $block_paid['paymentVerified'], 'Store API reverse-race POS payment was not completed.' );
$assert( $block_late->payment_complete() === false &&
    $block_late->payment_complete() === false,
    'Late Store API website payment or duplicate callback bypassed review.' );
$block_late = wc_get_order( $block_late->get_id() );
$assert( $block_late->has_status( 'on-hold' ) &&
    $block_late->get_meta( '_mansu_website_stock_review', true ) === 'required' &&
    (int) wc_get_product( $block_late_product->get_id() )->get_stock_quantity() === 0,
    'Duplicate Store API callback corrupted paid status or shared stock.' );

// 12. Paystack's underpayment/currency-mismatch path can call the Woo stock
// reducer independently of payment_complete(). Check the native reducer
// itself rejects an expired Store API hold; no actual gateway is contacted.
$direct_reducer_product = $make_simple();
$direct_reducer = wc_create_order( array( 'status' => 'pending', 'created_via' => 'store-api' ) );
$direct_reducer->add_product( $direct_reducer_product, 1 );
$direct_reducer->calculate_totals( false );
$direct_reducer->save();
$reserve->reserve_stock_for_order( $direct_reducer, 10 );
$reducer_expired = $wpdb->update( $wpdb->wc_reserved_stock,
    array( 'expires' => gmdate( 'Y-m-d H:i:s', time() - 30 ) ),
    array( 'order_id' => $direct_reducer->get_id() ) );
$assert( $reducer_expired === 1, 'Direct stock reducer original hold did not expire.' );
$reducer_key = '52a199e9-929a-4c99-97cd-d5366c4bc072';
$reducer_pos = $attempt( $direct_reducer_product, $reducer_key );
$assert( ! is_wp_error( $reducer_pos ) && $reducer_pos['reservationVerified'],
    'Direct reducer POS hold was not established.' );
wc_reduce_stock_levels( $direct_reducer->get_id() );
$direct_reducer = wc_get_order( $direct_reducer->get_id() );
$line = current( $direct_reducer->get_items( 'line_item' ) );
$assert( (int) ( $line ? $line->get_meta( '_reduced_stock', true ) : 0 ) === 0 &&
    $direct_reducer->get_meta( '_mansu_website_stock_review', true ) === 'required' &&
    (int) wc_get_product( $direct_reducer_product->get_id() )->get_stock_quantity() === 1,
    'A gateway direct Woo stock-reduction path bypassed original hold quarantine.' );
$assert( ! is_wp_error( mansu_online_cash_intent( $cash_request( $reducer_key, 'cash-intent' ) ) ) &&
    ! is_wp_error( mansu_online_pay( $cash_request( $reducer_key, 'pay' ) ) ) &&
    (int) wc_get_product( $direct_reducer_product->get_id() )->get_stock_quantity() === 0,
    'Direct reducer attempt damaged POS original held unit.' );

// 13. Quarantine is permanent until a separately audited human decision.
// Recreating the Woo hold after a delayed callback must NOT silently admit
// the original, already-disputed website payment on a later retry.
$reheld_product = $make_simple();
$reheld_website = $website_hold( $reheld_product );
$reheld_expired = $wpdb->update( $wpdb->wc_reserved_stock,
    array( 'expires' => gmdate( 'Y-m-d H:i:s', time() - 30 ) ),
    array( 'order_id' => $reheld_website->get_id() ) );
$assert( $reheld_expired === 1 && $reheld_website->payment_complete() === false &&
    $reheld_website->get_meta( '_mansu_website_stock_review', true ) === 'required',
    'Rehold fixture did not quarantine the original expired website payment.' );
wc_release_stock_for_order( $reheld_website );
// Deliberately model an unauthorized/admin reset of a quarantined on-hold
// order back to pending before trying to obtain a new reservation. This
// must never clear the permanent dispute marker or permit auto-payment.
$reheld_website = wc_get_order( $reheld_website->get_id() );
$reheld_website->update_status( 'pending', 'Synthetic operator reset; must not clear stock safety review.' );
$reserve->reserve_stock_for_order( $reheld_website, 10 );
$assert( (int) $reserve->get_reserved_stock( $reheld_product ) === 1,
    'Rehold fixture failed to create a fresh valid native Woo hold.' );
$reheld_retry = $reheld_website->payment_complete();
$reheld_website = wc_get_order( $reheld_website->get_id() );
$assert( $reheld_retry === false &&
    $reheld_website->has_status( 'on-hold' ) &&
    $reheld_website->get_meta( '_mansu_website_stock_review', true ) === 'required' &&
    (int) wc_get_product( $reheld_product->get_id() )->get_stock_quantity() === 1,
    'A fresh Woo reservation incorrectly re-authorised a quarantined gateway payment: callback=' .
      var_export( $reheld_retry, true ) . ' status=' . $reheld_website->get_status() .
      ' review=' . $reheld_website->get_meta( '_mansu_website_stock_review', true ) .
      ' stock=' . wc_get_product( $reheld_product->get_id() )->get_stock_quantity() );

// 14. Reproduce the actual Paystack mismatch ordering using pure Woo:
// expired website hold -> POS pays -> gateway status on-hold -> direct reducer.
// Woo's order-level stock_reduced flag is NOT proof that item lines reduced.
$mis_product = $make_simple();
$mis_website = $website_hold( $mis_product );
$mis_expired = $wpdb->update( $wpdb->wc_reserved_stock,
    array( 'expires' => gmdate( 'Y-m-d H:i:s', time() - 30 ) ),
    array( 'order_id' => $mis_website->get_id() ) );
$assert( $mis_expired === 1, 'Mispaid status fixture original website hold did not expire.' );
$mis_key = '1df05c34-00ef-4bf5-8853-d1cd934c14b7';
$mis_pos = $attempt( $mis_product, $mis_key );
$assert( ! is_wp_error( $mis_pos ) && $mis_pos['reservationVerified'] &&
    ! is_wp_error( mansu_online_cash_intent( $cash_request( $mis_key, 'cash-intent' ) ) ) &&
    ! is_wp_error( mansu_online_pay( $cash_request( $mis_key, 'pay' ) ) ),
    'Synthetic mismatch fixture POS sale failed.' );
$mis_website->update_status( 'on-hold', 'Synthetic wrong-currency Paystack gateway success.' );
wc_reduce_stock_levels( $mis_website->get_id() );
$mis_website = wc_get_order( $mis_website->get_id() );
$mis_line = current( $mis_website->get_items( 'line_item' ) );
$assert( $mis_website->has_status( 'on-hold' ) &&
    $mis_website->get_meta( '_mansu_website_stock_review', true ) === 'required' &&
    (int) ( $mis_line ? $mis_line->get_meta( '_reduced_stock', true ) : 0 ) === 0 &&
    (int) wc_get_product( $mis_product->get_id() )->get_stock_quantity() === 0,
    'Paystack-style on-hold plus direct reducer oversold the POS-owned last unit.' );

echo 'DISPOSABLE_WOO_LATE_WEBSITE_GUARD_OK: native Woo payment_complete, direct status and stock-reduction hooks quarantined expired website payments without overselling. NOT a Paystack-site guarantee.' . PHP_EOL;

echo 'DISPOSABLE_WOO_CORE_OK ' . $checks . ' assertions; real pinned Woo core, MySQL/InnoDB, checkout/POS holds, cash-intent, once-only Woo payment, delayed gateway race; NO real store.' . PHP_EOL;
