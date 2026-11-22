<?php
/**
 * WooCommerce integration: layout, product cards, bag drawer, WhatsApp ordering.
 *
 * Uses hooks rather than copies of WooCommerce templates wherever it can, so
 * WooCommerce updates keep working. Only archive-product.php and
 * content-product.php are overridden (see /woocommerce).
 *
 * @package Mansu_Maison
 */

defined( 'ABSPATH' ) || exit;

/* ---------- Layout ---------- */

add_filter( 'loop_shop_columns', fn() => 4 );
add_filter( 'loop_shop_per_page', fn() => 24 );
add_filter( 'woocommerce_output_related_products_args', fn( $a ) => array_merge( $a, array( 'posts_per_page' => 4, 'columns' => 4 ) ) );
add_filter( 'woocommerce_upsell_display_args', fn( $a ) => array_merge( $a, array( 'posts_per_page' => 4, 'columns' => 4 ) ) );
add_filter( 'woocommerce_cross_sells_columns', fn() => 4 );

/* The theme draws its own wrappers and has no sidebar. */
remove_action( 'woocommerce_before_main_content', 'woocommerce_output_content_wrapper', 10 );
remove_action( 'woocommerce_after_main_content', 'woocommerce_output_content_wrapper_end', 10 );
remove_action( 'woocommerce_sidebar', 'woocommerce_get_sidebar', 10 );
add_action( 'woocommerce_before_main_content', fn() => print '<main id="main" class="wc-main"><div class="wrap">', 10 );
add_action( 'woocommerce_after_main_content', fn() => print '</div></main>', 10 );

/* Breadcrumbs: Rank Math's when it is set up, else WooCommerce's. */
remove_action( 'woocommerce_before_main_content', 'woocommerce_breadcrumb', 20 );
add_action( 'woocommerce_before_main_content', 'mansu_breadcrumbs', 20 );
/**
 * Print breadcrumbs.
 */
function mansu_breadcrumbs() {
	if ( is_front_page() ) {
		return;
	}
	if ( function_exists( 'rank_math_the_breadcrumbs' ) && class_exists( '\RankMath\Helper' ) && \RankMath\Helper::is_breadcrumbs_enabled() ) {
		echo '<nav class="crumbs" aria-label="' . esc_attr__( 'Breadcrumb', 'mansu-maison' ) . '">';
		rank_math_the_breadcrumbs();
		echo '</nav>';
		return;
	}
	woocommerce_breadcrumb(
		array(
			'wrap_before' => '<nav class="crumbs" aria-label="' . esc_attr__( 'Breadcrumb', 'mansu-maison' ) . '"><ol>',
			'wrap_after'  => '</ol></nav>',
			'before'      => '<li>',
			'after'       => '</li>',
			'delimiter'   => '',
		)
	);
}

/* ---------- Product card ---------- */

/**
 * Colour swatch value for a pa_color term: the swatch plugin's colour, else a name match.
 *
 * @param WP_Term $term Colour term.
 * @return string CSS background value.
 */
function mansu_swatch( $term ) {
	foreach ( array( 'product_attribute_color', 'color', 'pa_color_swatches_id_color' ) as $key ) {
		$v = get_term_meta( $term->term_id, $key, true );
		if ( is_string( $v ) && preg_match( '/^#[0-9a-f]{3,8}$/i', $v ) ) {
			return $v;
		}
	}
	$map = array(
		'black' => '#1b1b1b', 'white' => '#f7f7f5', 'red' => '#c62828', 'green' => '#2e7d4f', 'yellow' => '#f3d250',
		'blue' => '#5b86c9', 'navy' => '#1f2f56', 'pink' => '#efa7bd', 'brown' => '#7a4a2a', 'coffee' => '#6f4e37',
		'wine' => '#6d1a2f', 'grey' => '#9a9a9a', 'gray' => '#9a9a9a', 'gold' => '#c9a24a', 'orange' => '#e8742c',
		'purple' => '#7b4aa8', 'lilac' => '#b9a6dc', 'nude' => '#d9b99b', 'cream' => '#efe6d2', 'beige' => '#d8c6a5', 'peach' => '#f4b99a',
	);
	$name = strtolower( $term->name );
	foreach ( $map as $k => $hex ) {
		if ( false !== strpos( $name, $k ) ) {
			return $hex;
		}
	}
	return '#b5b0b3';
}

/**
 * Colour dots for a product card.
 *
 * @param WC_Product $product Product.
 * @return string HTML.
 */
function mansu_colour_dots( $product ) {
	$terms = wc_get_product_terms( $product->get_id(), 'pa_color', array( 'fields' => 'all' ) );
	if ( ! $terms ) {
		return '';
	}
	$html = '<span class="dots">';
	foreach ( array_slice( $terms, 0, 4 ) as $t ) {
		$html .= '<i style="background:' . esc_attr( mansu_swatch( $t ) ) . '" title="' . esc_attr( $t->name ) . '"></i>';
	}
	/* translators: %d: number of colours */
	$label = sprintf( _n( '%d colour', '%d colours', count( $terms ), 'mansu-maison' ), count( $terms ) );
	return $html . '<span class="screen-reader-text">' . esc_html( $label ) . '</span></span>';
}

/**
 * Whether a product is "new": published in the last 21 days.
 *
 * @param WC_Product $product Product.
 * @return bool
 */
function mansu_is_new( $product ) {
	$created = $product->get_date_created();
	return $created && ( time() - $created->getTimestamp() ) < 21 * DAY_IN_SECONDS;
}

/* ---------- Bag drawer ---------- */

/**
 * WhatsApp message listing what is in the cart.
 *
 * @return string wa.me URL.
 */
function mansu_cart_wa_link() {
	if ( ! WC()->cart || WC()->cart->is_empty() ) {
		return mansu_wa_link();
	}
	$lines = array( __( 'Hello Mansutrendzgh, I would like to order:', 'mansu-maison' ) );
	foreach ( WC()->cart->get_cart() as $item ) {
		$p    = $item['data'];
		$opts = array();
		if ( ! empty( $item['variation'] ) ) {
			foreach ( $item['variation'] as $key => $val ) {
				$tax = str_replace( 'attribute_', '', $key );
				$term = taxonomy_exists( $tax ) ? get_term_by( 'slug', $val, $tax ) : false;
				$opts[] = $term ? $term->name : $val;
			}
		}
		$lines[] = sprintf(
			'• %1$s%2$s × %3$d = %4$s',
			$p->get_title(), // For a variation this is the parent's name; options are listed separately.
			$opts ? ' (' . implode( ', ', $opts ) . ')' : '',
			$item['quantity'],
			wp_strip_all_tags( wc_price( $item['line_total'] + $item['line_tax'] ) )
		);
	}
	/* translators: %s: cart total */
	$lines[] = sprintf( __( 'Total: %s', 'mansu-maison' ), wp_strip_all_tags( WC()->cart->get_cart_total() ) );
	$lines[] = __( 'Delivery area: ', 'mansu-maison' );
	return mansu_wa_link( html_entity_decode( implode( "\n", $lines ), ENT_QUOTES, 'UTF-8' ) );
}

/* Keep the header count and the drawer's WhatsApp link in sync after AJAX cart changes. */
add_filter(
	'woocommerce_add_to_cart_fragments',
	function ( $fragments ) {
		$count = WC()->cart ? WC()->cart->get_cart_contents_count() : 0;
		$fragments['span.bag-count']   = '<span class="bag-count" aria-live="polite">' . (int) $count . '</span>';
		$fragments['#bagD a.bag-wa']   = '<a class="btn-ghost bag-wa" href="' . esc_url( mansu_cart_wa_link() ) . '" target="_blank" rel="noopener">' . esc_html__( 'Order on WhatsApp', 'mansu-maison' ) . '</a>';
		return $fragments;
	}
);

/* Cart page: offer WhatsApp ordering next to Proceed to checkout. */
add_action(
	'woocommerce_proceed_to_checkout',
	function () {
		echo '<a class="btn-ghost bag-wa wide" href="' . esc_url( mansu_cart_wa_link() ) . '" target="_blank" rel="noopener">' . esc_html__( 'Or order on WhatsApp', 'mansu-maison' ) . '</a>';
	},
	30
);

/* ---------- Single product ---------- */

add_action(
	'woocommerce_single_product_summary',
	function () {
		global $product;
		$msg = sprintf(
			/* translators: 1: product name, 2: product URL */
			__( 'Hello Mansutrendzgh, I have a question about %1$s: %2$s', 'mansu-maison' ),
			$product->get_name(),
			get_permalink( $product->get_id() )
		);
		echo '<div class="pdp-extra">';
		echo '<a class="btn-ghost wide" href="' . esc_url( mansu_wa_link( $msg ) ) . '" target="_blank" rel="noopener">' . esc_html__( 'Ask about this on WhatsApp', 'mansu-maison' ) . '</a>';
		echo '<ul class="pdp-notes">';
		echo '<li>' . esc_html__( 'Delivery across Ghana, or collect from our Accra showroom', 'mansu-maison' ) . '</li>';
		echo '<li>' . esc_html__( 'Wholesale prices for boutiques on request', 'mansu-maison' ) . '</li>';
		echo '<li>' . esc_html__( 'Between sizes? Ask us for the garment measurements', 'mansu-maison' ) . '</li>';
		echo '</ul></div>';
	},
	35
);

/* ---------- Catalogue queries ---------- */

/**
 * Leave photo-less products out of shop lists and search (Customizer setting).
 * The live catalogue has ~1,570 such items, mostly one product per size.
 */
add_action(
	'pre_get_posts',
	function ( WP_Query $q ) {
		if ( is_admin() || ! $q->is_main_query() || ! mansu_opt( 'hide_no_photo' ) ) {
			return;
		}
		$is_product_list = $q->is_post_type_archive( 'product' ) || $q->is_tax( array( 'product_cat', 'product_tag' ) ) || ( $q->is_search() && 'product' === $q->get( 'post_type' ) );
		if ( ! $is_product_list && ! ( function_exists( 'is_shop' ) && $q->get( 'page_id' ) && (int) $q->get( 'page_id' ) === wc_get_page_id( 'shop' ) ) ) {
			return;
		}
		$meta   = (array) $q->get( 'meta_query' );
		$meta[] = array( 'key' => '_thumbnail_id', 'compare' => 'EXISTS' );
		$q->set( 'meta_query', $meta );
	},
	20
);

/**
 * Shoppers type "trousers", "co-ord" or "gown"; the catalogue says "pant", "set", "dress".
 *
 * @param string $s Search phrase.
 * @return string
 */
function mansu_search_synonyms( $s ) {
	$map = array(
		'trousers' => 'pant', 'trouser' => 'pant', 'pants' => 'pant', 'jeans' => 'denim', 'jean' => 'denim',
		'blouse' => 'top', 'tops' => 'top', 'shirts' => 'shirt', 'dresses' => 'dress', 'gown' => 'dress',
		'sets' => 'set', 'two-piece' => 'set', 'twopiece' => 'set', 'coord' => 'set', 'co-ord' => 'set',
		'kaftans' => 'kaftan', 'caftan' => 'kaftan', 'abayas' => 'abaya', 'skirts' => 'skirt', 'gray' => 'grey',
	);
	$words = preg_split( '/\s+/', strtolower( trim( $s ) ) );
	return implode( ' ', array_map( fn( $w ) => $map[ $w ] ?? $w, $words ) );
}

add_action(
	'pre_get_posts',
	function ( WP_Query $q ) {
		if ( ! is_admin() && $q->is_main_query() && $q->is_search() && 'product' === $q->get( 'post_type' ) ) {
			$q->set( 's', mansu_search_synonyms( (string) $q->get( 's' ) ) );
		}
	},
	5
);

/* A search box anywhere on the site searches products. */
add_filter(
	'get_search_form',
	function ( $form ) {
		return str_replace( '</form>', '<input type="hidden" name="post_type" value="product"></form>', $form );
	}
);
