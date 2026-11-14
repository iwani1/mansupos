<?php
/**
 * Disposable WP-CLI fixture and assertions for real Paystack WC-API endpoints.
 * All products, transaction references and payment verification are synthetic.
 */
if ( ! defined( 'WP_CLI' ) || ! WP_CLI ||
     ! defined( 'MANSU_CI_DISPOSABLE_WOO' ) || MANSU_CI_DISPOSABLE_WOO !== true ||
     ! defined( 'MANSU_ONLINE_BRIDGE_SERVICE' ) || MANSU_ONLINE_BRIDGE_SERVICE !== 'staging' ||
     wp_get_environment_type() !== 'local' ||
     get_option( 'blogname' ) !== 'Mansu isolated CI stock test' ||
     WC_VERSION !== MANSU_ONLINE_PINNED_WOO ||
     ! defined( 'WC_PAYSTACK_VERSION' ) || WC_PAYSTACK_VERSION !== '5.8.6' ) {
    throw new RuntimeException( 'Refusing Paystack HTTP exercise outside pinned disposable CI.' );
}
$phase = getenv( 'MANSU_CI_PAYSTACK_HTTP_PHASE' );
$checks = 0;
$assert = static function ( $value, $message ) use ( &$checks ) {
    ++$checks;
    if ( ! $value ) { throw new RuntimeException( $message ); }
};
global $wpdb;
if ( $phase === 'setup' ) {
    update_option( 'woocommerce_paystack_settings', array(
        'enabled' => 'yes', 'testmode' => 'yes',
        'test_public_key' => 'pk_test_synthetic_ci_no_real_account',
        'test_secret_key' => 'sk_test_synthetic_ci_no_real_account',
        'payment_page' => 'redirect', 'autocomplete_order' => 'no',
        'saved_cards' => 'no',
    ) );
    $reserve = new \Automattic\WooCommerce\Checkout\Helpers\ReserveStock();
    $cases = array();
    foreach ( array(
        'webhook_valid' => array( 'checkout', false, 'exact' ),
        'webhook_late' => array( 'store-api', true, 'exact' ),
        'return_valid' => array( 'store-api', false, 'exact' ),
        'return_late' => array( 'checkout', true, 'exact' ),
        'webhook_mismatch' => array( 'store-api', true, 'wrong-currency' ),
        'webhook_underpaid' => array( 'checkout', true, 'underpaid' ),
        // The return URL contains a valid, synthetic Paystack transaction,
        // but it does not match the reference originally saved on the order.
        'return_reference_mismatch' => array( 'store-api', false, 'reference-mismatch' ),
        'webhook_verify_failed' => array( 'checkout', false, 'verify-failed' ),
        // True two-worker HTTP races use the same synthetic payment reference.
        'race_valid' => array( 'store-api', false, 'race-valid' ),
        'race_late' => array( 'checkout', true, 'race-late' ),
    ) as $name => $spec ) {
        $product = new WC_Product_Simple();
        $product->set_name( 'SYNTHETIC HTTP PAYSTACK ' . $name );
        $product->set_status( 'publish' );
        $product->set_regular_price( '100.00' );
        $product->set_manage_stock( true );
        $product->set_stock_quantity( 1 );
        $product->set_backorders( 'no' );
        $product->set_sku( 'SYNTHETIC-HTTP-' . wp_generate_uuid4() );
        $product->save();
        $order = wc_create_order( array( 'status' => 'pending', 'created_via' => $spec[0] ) );
        $order->add_product( $product, 1 );
        $order->set_payment_method( 'paystack' );
        $order->set_billing_email( 'synthetic@example.invalid' );
        $order->calculate_totals( false );
        $ref = $order->get_id() . '_synthetic_http_' . $name;
        $order->update_meta_data( '_paystack_txn_ref',
            $spec[2] === 'reference-mismatch' ? $ref . '_different_attempt' : $ref );
        $order->save();
        $reserve->reserve_stock_for_order( $order, 10 );
        $assert( (int) $reserve->get_reserved_stock( $product ) === 1,
            'Initial Woo held stock not created for ' . $name );
        if ( $spec[1] ) {
            $changed = $wpdb->update( $wpdb->wc_reserved_stock,
                array( 'expires' => gmdate( 'Y-m-d H:i:s', time() - 30 ) ),
                array( 'order_id' => $order->get_id() ) );
            $assert( $changed === 1, 'Website hold expiry failed for ' . $name );
            // A competing POS sale has taken the final unit. Actual POS
            // reservation and concurrency is separately tested in CI.
            wc_update_product_stock( $product, 0, 'set' );
        }
        $cases[ $name ] = array(
            'id' => $order->get_id(), 'product' => $product->get_id(),
            'ref' => $ref, 'mode' => $spec[2],
        );
    }
    // Barrier markers are owned by the throwaway WordPress directory only.
    foreach ( array( 'race-valid', 'race-late' ) as $mode ) {
        $dir = WP_CONTENT_DIR . '/mansu-ci-paystack-' . $mode;
        $assert( ! is_dir( $dir ) && wp_mkdir_p( $dir ), 'Could not prepare synthetic race barrier.' );
    }
    update_option( 'mansu_ci_paystack_http_cases', $cases, false );
    echo 'DISPOSABLE_PAYSTACK_HTTP_SETUP ' . wp_json_encode( $cases ) . PHP_EOL;
    exit;
}
$cases = get_option( 'mansu_ci_paystack_http_cases', array() );
$case = static function ( $name ) use ( $cases, $assert ) {
    $assert( isset( $cases[ $name ] ), 'Missing HTTP callback fixture ' . $name );
    $entry = $cases[ $name ];
    $order = wc_get_order( $entry['id'] );
    $product = wc_get_product( $entry['product'] );
    $line = current( $order->get_items( 'line_item' ) );
    return array( $order, $product, $line ? (int) $line->get_meta( '_reduced_stock', true ) : 0 );
};
$valid = static function ( $name ) use ( $case, $assert ) {
    list( $order, $product, $reduced ) = $case( $name );
    $assert( $order->is_paid() && (bool) $order->get_date_paid() &&
        $order->get_meta( '_mansu_website_stock_review', true ) !== 'required' &&
        (int) $product->get_stock_quantity() === 0 && $reduced === 1,
        'Genuine Paystack endpoint did not complete valid held ' . $name );
};
$late = static function ( $name, $status = 'on-hold' ) use ( $case, $assert ) {
    list( $order, $product, $reduced ) = $case( $name );
    $assert( $order->has_status( $status ) &&
        $order->get_meta( '_mansu_website_stock_review', true ) === 'required' &&
        ! $order->get_date_paid() &&
        (int) $product->get_stock_quantity() === 0 && $reduced === 0,
        'Late Paystack endpoint oversold or lost review for ' . $name .
            ': status=' . $order->get_status() .
            ' review=' . $order->get_meta( '_mansu_website_stock_review', true ) .
            ' stock=' . $product->get_stock_quantity() . ' reduced=' . $reduced );
};
switch ( $phase ) {
    case 'invalid-hmac':
        list( $order, $product, $reduced ) = $case( 'webhook_late' );
        $assert( $order->has_status( 'pending' ) &&
            $order->get_meta( '_mansu_website_stock_review', true ) !== 'required' &&
            ! $order->get_date_paid() &&
            (int) $product->get_stock_quantity() === 0 && $reduced === 0,
            'Bad Paystack webhook HMAC changed a synthetic Woo order.' );
        break;
    case 'webhook-valid':
        $valid( 'webhook_valid' );
        break;
    case 'webhook-replay':
        $valid( 'webhook_valid' );
        list( $order ) = $case( 'webhook_valid' );
        $paystack_notes = 0;
        foreach ( wc_get_order_notes( array( 'order_id' => $order->get_id(), 'limit' => 100 ) ) as $note ) {
            if ( strpos( $note->content, 'Payment via Paystack successful' ) !== false ) {
                ++$paystack_notes;
            }
        }
        $assert( $paystack_notes === 1,
            'Repeated successful Paystack webhook produced duplicate success notes.' );
        break;
    case 'webhook-late':
        $late( 'webhook_late' );
        break;
    case 'webhook-late-replay':
        $late( 'webhook_late' );
        list( $order ) = $case( 'webhook_late' );
        $paystack_notes = 0;
        foreach ( wc_get_order_notes( array( 'order_id' => $order->get_id(), 'limit' => 100 ) ) as $note ) {
            if ( strpos( $note->content, 'Payment via Paystack successful' ) !== false ) {
                ++$paystack_notes;
            }
        }
        $assert( $paystack_notes === 1,
            'Repeated expired-hold webhook generated duplicate Paystack success evidence.' );
        break;
    case 'webhook-underpaid':
        $late( 'webhook_underpaid', 'on-hold' );
        break;
    case 'return-valid':
        $valid( 'return_valid' );
        break;
    case 'return-late':
        $late( 'return_late' );
        break;
    case 'webhook-mismatch':
        $late( 'webhook_mismatch', 'on-hold' );
        break;
    case 'race-valid':
        list( $order, $product, $reduced ) = $case( 'race_valid' );
        $race_markers = glob( WP_CONTENT_DIR . '/mansu-ci-paystack-race-valid/verify-*' );
        $race_arrivals = glob( WP_CONTENT_DIR . '/mansu-ci-paystack-race-valid/arrival-*' );
        $debug_notes = wc_get_order_notes( array( 'order_id' => $order->get_id(), 'limit' => 100 ) );
        $debug_success = array_filter( $debug_notes, static function ( $note ) {
            return strpos( $note->content, 'Payment via Paystack successful' ) !== false;
        } );
        echo 'PAYSTACK_RACE_VALID_DIAGNOSTICS ' . wp_json_encode( array(
            'workers_at_verifier' => count( $race_markers ),
            'workers_at_entry' => count( $race_arrivals ),
            'status' => $order->get_status(),
            'paid_date_present' => (bool) $order->get_date_paid(),
            'review' => $order->get_meta( '_mansu_website_stock_review', true ),
            'stock' => $product->get_stock_quantity(),
            'line_reduced' => $reduced,
            'success_notes' => count( $debug_success ),
        ) ) . PHP_EOL;
        $assert( count( $race_arrivals ) === 2 && count( $race_markers ) === 2,
            'Valid callback race did not start in two workers and verify both requests.' );
        $valid( 'race_valid' );
        list( $order ) = $case( 'race_valid' );
        $notes = wc_get_order_notes( array( 'order_id' => $order->get_id(), 'limit' => 100 ) );
        $success_notes = array_filter( $notes, static function ( $note ) {
            return strpos( $note->content, 'Payment via Paystack successful' ) !== false;
        } );
        $assert( count( $success_notes ) === 1,
            'Concurrent valid webhook/return callbacks generated multiple Paystack success notes; count=' . count( $success_notes ) );
        $race_markers = glob( WP_CONTENT_DIR . '/mansu-ci-paystack-race-valid/verify-*' );
        $assert( count( $race_markers ) === 2,
            'Valid callback race was not reached independently by two PHP workers.' );
        break;
    case 'race-late':
        list( $order, $product, $reduced ) = $case( 'race_late' );
        $race_markers = glob( WP_CONTENT_DIR . '/mansu-ci-paystack-race-late/verify-*' );
        $race_arrivals = glob( WP_CONTENT_DIR . '/mansu-ci-paystack-race-late/arrival-*' );
        echo 'PAYSTACK_RACE_LATE_DIAGNOSTICS ' . wp_json_encode( array(
            'workers_at_verifier' => count( $race_markers ),
            'workers_at_entry' => count( $race_arrivals ),
            'status' => $order->get_status(),
            'review' => $order->get_meta( '_mansu_website_stock_review', true ),
            'stock' => $product->get_stock_quantity(),
            'line_reduced' => $reduced,
        ) ) . PHP_EOL;
        $assert( count( $race_arrivals ) === 2 && count( $race_markers ) === 2,
            'Late callback race did not start in two workers and verify both requests.' );
        $late( 'race_late' );
        list( $order ) = $case( 'race_late' );
        $notes = wc_get_order_notes( array( 'order_id' => $order->get_id(), 'limit' => 100 ) );
        $success_notes = array_filter( $notes, static function ( $note ) {
            return strpos( $note->content, 'Payment via Paystack successful' ) !== false;
        } );
        $assert( count( $success_notes ) === 1,
            'Concurrent late webhook/return callbacks generated multiple Paystack success notes; count=' . count( $success_notes ) );
        $race_markers = glob( WP_CONTENT_DIR . '/mansu-ci-paystack-race-late/verify-*' );
        $assert( count( $race_markers ) === 2,
            'Late callback race was not reached independently by two PHP workers.' );
        break;
    case 'webhook-verify-failed':
        list( $order, $product, $reduced ) = $case( 'webhook_verify_failed' );
        $notes = wc_get_order_notes( array( 'order_id' => $order->get_id(), 'limit' => 50 ) );
        $success_notes = array_filter( $notes, static function ( $note ) {
            return strpos( $note->content, 'Payment via Paystack successful' ) !== false;
        } );
        $assert( $order->has_status( 'pending' ) && ! $order->get_date_paid() &&
            $order->get_meta( '_mansu_website_stock_review', true ) !== 'required' &&
            (int) $product->get_stock_quantity() === 1 && $reduced === 0 &&
            count( $success_notes ) === 0,
            'Failed Paystack verification wrongly completed or reduced a healthy pending order.' );
        break;
    case 'return-reference-mismatch':
        list( $order, $product, $reduced ) = $case( 'return_reference_mismatch' );
        $assert( $order->has_status( 'on-hold' ) &&
            $order->get_meta( '_mansu_website_stock_review', true ) === 'required' &&
            ! $order->get_date_paid() &&
            (int) $product->get_stock_quantity() === 1 && $reduced === 0,
            'Paystack return accepted a transaction not bound to the original order: ' .
                'status=' . $order->get_status() .
                ' review=' . $order->get_meta( '_mansu_website_stock_review', true ) .
                ' stock=' . $product->get_stock_quantity() .
                ' reduced=' . $reduced );
        break;
    default:
        throw new RuntimeException( 'Unknown Paystack synthetic HTTP phase.' );
}
echo 'DISPOSABLE_PAYSTACK_HTTP_' . strtoupper( str_replace( '-', '_', $phase ) ) .
    '_OK ' . $checks . ' assertions; no external Paystack calls.' . PHP_EOL;
