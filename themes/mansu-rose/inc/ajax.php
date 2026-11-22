<?php
/**
 * wc-ajax endpoints used by rose.js. They run through WooCommerce's AJAX
 * front controller, so the cart and session are loaded.
 *
 *  ?wc-ajax=mansu_search&q=yellow       predictive search (GET, cacheable)
 *  ?wc-ajax=mansu_quick_view&id=123     quick view HTML with the real add-to-cart form
 *  ?wc-ajax=mansu_add_to_cart  (POST)   add a simple product or a variation, returns cart fragments
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;

add_action( 'wc_ajax_mansu_search', 'mansu_ajax_search' );
add_action( 'wc_ajax_mansu_quick_view', 'mansu_ajax_quick_view' );
add_action( 'wc_ajax_mansu_add_to_cart', 'mansu_ajax_add_to_cart' );

/**
 * Predictive search: up to 6 products and any matching featured categories.
 */
function mansu_ajax_search() {
	// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- public, read-only.
	$q = isset( $_GET['q'] ) ? sanitize_text_field( wp_unslash( $_GET['q'] ) ) : '';
	$q = mb_substr( trim( $q ), 0, 60 );
	if ( mb_strlen( $q ) < 2 ) {
		wp_send_json( array( 'products' => array(), 'cats' => array(), 'total' => 0 ) );
	}
	$term = mansu_search_synonyms( $q );
	$key  = 'mansu_s_' . md5( $term . (int) mansu_opt( 'hide_no_photo' ) );
	$out  = get_transient( $key );
	if ( false === $out ) {
		$args = array(
			'post_type'      => 'product',
			'post_status'    => 'publish',
			's'              => $term,
			'posts_per_page' => 6,
			'fields'         => 'ids',
			'tax_query'      => WC()->query->get_tax_query(), // phpcs:ignore WordPress.DB.SlowDBQuery -- respects catalogue visibility.
		);
		if ( mansu_opt( 'hide_no_photo' ) ) {
			$args['meta_query'] = array( array( 'key' => '_thumbnail_id', 'compare' => 'EXISTS' ) ); // phpcs:ignore WordPress.DB.SlowDBQuery
		}
		$query    = new WP_Query( $args );
		$products = array();
		foreach ( $query->posts as $id ) {
			$p = wc_get_product( $id );
			if ( ! $p ) {
				continue;
			}
			$img        = wp_get_attachment_image_src( $p->get_image_id(), 'woocommerce_thumbnail' );
			$products[] = array(
				'id'    => $p->get_id(),
				'name'  => wp_strip_all_tags( $p->get_name() ),
				'price' => wp_strip_all_tags( wc_price( wc_get_price_to_display( $p ) ) ),
				'url'   => get_permalink( $p->get_id() ),
				'img'   => $img ? $img[0] : wc_placeholder_img_src(),
				'opts'  => $p->is_type( 'variable' ),
			);
		}
		$cats = array();
		foreach ( mansu_featured_cats() as $c ) {
			foreach ( preg_split( '/\s+/', strtolower( $term ) ) as $w ) {
				if ( strlen( $w ) > 2 && false !== strpos( strtolower( $c->name ), rtrim( $w, 's' ) ) ) {
					$cats[] = array( 'name' => $c->name, 'url' => get_term_link( $c ) );
					break;
				}
			}
		}
		$out = array( 'products' => $products, 'cats' => $cats, 'total' => (int) $query->found_posts );
		set_transient( $key, $out, 10 * MINUTE_IN_SECONDS );
	}
	header( 'Cache-Control: public, max-age=300' );
	wp_send_json( $out );
}

/**
 * Quick view: gallery + summary + WooCommerce's own add-to-cart form.
 */
function mansu_ajax_quick_view() {
	// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- public, read-only.
	$id      = isset( $_GET['id'] ) ? absint( $_GET['id'] ) : 0;
	$product = $id ? wc_get_product( $id ) : null;
	if ( ! $product || 'publish' !== $product->get_status() || ! $product->is_visible() ) {
		wp_send_json_error( null, 404 );
	}
	global $post;
	$post = get_post( $id ); // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited
	setup_postdata( $post );
	$GLOBALS['product'] = $product;

	$images = array_slice( array_filter( array_merge( array( $product->get_image_id() ), $product->get_gallery_image_ids() ) ), 0, 4 );
	ob_start();
	?>
	<div class="qv">
		<button class="qv-x" type="button" data-close aria-label="<?php esc_attr_e( 'Close', 'mansu-rose' ); ?>"><?php echo mansu_icon( 'close' ); // phpcs:ignore WordPress.Security.EscapeOutput ?></button>
		<div class="qv-media">
			<?php
			foreach ( $images as $i => $img ) {
				echo wp_get_attachment_image( $img, 'woocommerce_single', false, array( 'loading' => $i ? 'lazy' : 'eager', 'alt' => $i ? '' : $product->get_name() ) );
			}
			?>
		</div>
		<div class="qv-info">
			<p class="qv-cat"><?php echo wp_kses_post( wc_get_product_category_list( $id, ' · ' ) ); ?></p>
			<h2 id="qv-title"><?php echo esc_html( $product->get_name() ); ?></h2>
			<p class="qv-price"><?php echo wp_kses_post( $product->get_price_html() ); ?></p>
			<?php if ( $product->get_short_description() ) : ?>
				<div class="qv-desc"><?php echo wp_kses_post( wpautop( $product->get_short_description() ) ); ?></div>
			<?php endif; ?>
			<div class="qv-form"><?php woocommerce_template_single_add_to_cart(); ?></div>
			<p class="qv-msg" role="status" aria-live="polite"></p>
			<a class="link-u" href="<?php echo esc_url( get_permalink( $id ) ); ?>"><?php esc_html_e( 'Full details & photos', 'mansu-rose' ); ?></a>
		</div>
	</div>
	<?php
	$html = ob_get_clean();
	wp_reset_postdata();
	wp_send_json_success( array( 'html' => $html ) );
}

/**
 * Add to cart from quick view. Unlike WooCommerce's built-in AJAX handler, this
 * passes the chosen attributes, so variations with "any size" options work.
 */
function mansu_ajax_add_to_cart() {
	// phpcs:disable WordPress.Security.NonceVerification.Missing -- WooCommerce cart actions are nonce-less by design.
	$product_id   = isset( $_POST['product_id'] ) ? absint( $_POST['product_id'] ) : 0;
	$variation_id = isset( $_POST['variation_id'] ) ? absint( $_POST['variation_id'] ) : 0;
	$quantity     = isset( $_POST['quantity'] ) ? max( 1, wc_stock_amount( wp_unslash( $_POST['quantity'] ) ) ) : 1;
	$variation    = array();
	foreach ( $_POST as $key => $value ) {
		if ( 0 === strpos( (string) $key, 'attribute_' ) ) {
			$variation[ sanitize_title( wp_unslash( $key ) ) ] = wc_clean( wp_unslash( $value ) );
		}
	}
	// phpcs:enable
	$product = wc_get_product( $variation_id ? $variation_id : $product_id );
	if ( ! $product ) {
		wp_send_json( array( 'error' => true, 'message' => __( 'That product is not available.', 'mansu-rose' ) ) );
	}
	$passed = apply_filters( 'woocommerce_add_to_cart_validation', true, $product_id, $quantity, $variation_id, $variation );
	if ( $passed && false !== WC()->cart->add_to_cart( $product_id, $quantity, $variation_id, $variation ) ) {
		do_action( 'woocommerce_ajax_added_to_cart', $product_id );
		WC_AJAX::get_refreshed_fragments(); // Sends JSON and exits.
	}
	$notices = wc_get_notices( 'error' );
	wc_clear_notices();
	wp_send_json(
		array(
			'error'   => true,
			'message' => $notices ? wp_strip_all_tags( $notices[0]['notice'] ) : __( 'That did not work. Open the product page to try again.', 'mansu-rose' ),
			'url'     => get_permalink( $product_id ),
		)
	);
}
