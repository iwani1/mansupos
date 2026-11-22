<?php
/**
 * Product card in every product list (shop, categories, search, related, home rails).
 *
 * Overrides WooCommerce's content-product.php to use the Rosé card: second
 * photo on hover, quick view, colour dots. Plugins that hook
 * woocommerce_after_shop_loop_item (e.g. wishlist buttons) still run.
 *
 * @see     https://woocommerce.com/document/template-structure/
 * @package Mansu_Rose
 * @version 9.4.0
 */

defined( 'ABSPATH' ) || exit;

global $product;

if ( ! is_a( $product, WC_Product::class ) || ! $product->is_visible() ) {
	return;
}

$link     = $product->get_permalink();
$gallery  = $product->get_gallery_image_ids();
$heading  = is_front_page() ? 'h3' : 'h2';
$can_buy  = $product->is_purchasable() && $product->is_in_stock();
$badge    = '';
if ( ! $product->is_in_stock() ) {
	$badge = __( 'Sold out', 'mansu-rose' );
} elseif ( $product->is_on_sale() ) {
	$badge = __( 'Sale', 'mansu-rose' );
} elseif ( mansu_is_new( $product ) ) {
	$badge = __( 'New', 'mansu-rose' );
}
?>
<li <?php wc_product_class( 'card', $product ); ?>>
	<a class="media" href="<?php echo esc_url( $link ); ?>" tabindex="-1" aria-hidden="true">
		<?php echo $product->get_image( 'woocommerce_thumbnail', array( 'class' => 'img-main' ) ); // phpcs:ignore WordPress.Security.EscapeOutput ?>
		<?php
		if ( $gallery ) {
			echo wp_get_attachment_image( $gallery[0], 'woocommerce_thumbnail', false, array( 'class' => 'img-alt', 'alt' => '', 'loading' => 'lazy', 'decoding' => 'async' ) );
		}
		?>
		<?php if ( $badge ) : ?><span class="badge"><?php echo esc_html( $badge ); ?></span><?php endif; ?>
	</a>
	<?php if ( $can_buy ) : ?>
		<button class="qbtn" type="button" data-qv="<?php echo esc_attr( $product->get_id() ); ?>"><?php echo esc_html( $product->is_type( 'variable' ) ? __( 'Choose size', 'mansu-rose' ) : __( 'Add to bag', 'mansu-rose' ) ); ?><span class="screen-reader-text">: <?php echo esc_html( $product->get_name() ); ?></span></button>
	<?php endif; ?>
	<<?php echo esc_html( $heading ); ?> class="card-title"><a href="<?php echo esc_url( $link ); ?>"><?php echo esc_html( $product->get_name() ); ?></a></<?php echo esc_html( $heading ); ?>>
	<div class="meta">
		<span class="price"><?php echo wp_kses_post( $product->get_price_html() ); ?></span>
		<?php echo mansu_colour_dots( $product ); // phpcs:ignore WordPress.Security.EscapeOutput ?>
	</div>
	<?php
	/*
	 * Keep third-party loop additions, but not WooCommerce's own add-to-cart button
	 * (quick view replaces it) or the link wrappers (the card has its own links).
	 */
	remove_action( 'woocommerce_after_shop_loop_item', 'woocommerce_template_loop_product_link_close', 5 );
	remove_action( 'woocommerce_after_shop_loop_item', 'woocommerce_template_loop_add_to_cart', 10 );
	ob_start();
	do_action( 'woocommerce_after_shop_loop_item' );
	$extra = trim( ob_get_clean() );
	if ( $extra ) {
		echo '<div class="card-extra">' . $extra . '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput
	}
	?>
</li>
