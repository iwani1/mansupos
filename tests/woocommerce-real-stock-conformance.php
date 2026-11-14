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
if ( ! function_exists( 'mansu_online_attempt' ) || ! class_exists( '\\Automattic\\WooCommerce\\Checkout\\Helpers\\ReserveStock' ) ) {
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
    $product->set_sku( 'SYNTHETIC-LAST-UNIT-01' );
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
    $stock = new \\Automattic\\WooCommerce\\Checkout\\Helpers\\ReserveStock();
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
$reserve = new \\Automattic\\WooCommerce\\Checkout\\Helpers\\ReserveStock();
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

echo 'DISPOSABLE_WOO_CORE_OK ' . $checks . ' assertions; real pinned Woo core, MySQL/InnoDB, checkout/POS holds; NO real store.' . PHP_EOL;
