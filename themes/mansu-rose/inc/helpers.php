<?php
/**
 * Small helpers shared by templates.
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;

/**
 * Read a theme option with the default declared in customizer.php.
 *
 * @param string $key Setting key without the mansu_ prefix.
 * @return mixed
 */
function mansu_opt( $key ) {
	$defaults = mansu_defaults();
	return get_theme_mod( 'mansu_' . $key, isset( $defaults[ $key ] ) ? $defaults[ $key ] : '' );
}

/**
 * WhatsApp number as digits only, for wa.me links.
 *
 * @return string
 */
function mansu_wa_digits() {
	return preg_replace( '/\D+/', '', (string) mansu_opt( 'whatsapp' ) );
}

/**
 * A wa.me link with a prefilled message.
 *
 * @param string $text Message.
 * @return string
 */
function mansu_wa_link( $text = '' ) {
	if ( '' === $text ) {
		$text = __( 'Hello Mansutrendzgh, I have a question about an item.', 'mansu-rose' );
	}
	return 'https://wa.me/' . mansu_wa_digits() . '?text=' . rawurlencode( $text );
}

/**
 * Inline SVG icon (decorative; callers add text labels).
 *
 * @param string $name Icon name.
 * @return string
 */
function mansu_icon( $name ) {
	$paths = array(
		'search' => '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
		'bag'    => '<path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
		'menu'   => '<path d="M3 7h18M3 12h18M3 17h18"/>',
		'close'  => '<path d="M6 6l12 12M18 6 6 18"/>',
		'heart'  => '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/>',
		'user'   => '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
	);
	if ( ! isset( $paths[ $name ] ) ) {
		return '';
	}
	return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' . $paths[ $name ] . '</svg>';
}

/**
 * Parse "Question | Answer" lines from the FAQ setting.
 *
 * @return array<int, array{0:string,1:string}>
 */
function mansu_faq_items() {
	$out = array();
	foreach ( preg_split( '/\r\n|\r|\n/', (string) mansu_opt( 'faq' ) ) as $line ) {
		$parts = array_map( 'trim', explode( '|', $line, 2 ) );
		if ( 2 === count( $parts ) && '' !== $parts[0] && '' !== $parts[1] ) {
			$out[] = $parts;
		}
	}
	return $out;
}

/**
 * Product categories shown as tiles, pills and menu fallback, in Customizer order.
 *
 * @return WP_Term[]
 */
function mansu_featured_cats() {
	static $cache = null;
	if ( null !== $cache ) {
		return $cache;
	}
	$cache = array();
	foreach ( array_filter( array_map( 'trim', explode( ',', (string) mansu_opt( 'cats' ) ) ) ) as $slug ) {
		$term = get_term_by( 'slug', sanitize_title( $slug ), 'product_cat' );
		if ( $term && ! is_wp_error( $term ) ) {
			$cache[] = $term;
		}
	}
	return $cache;
}

/**
 * Occasions: label + product tag slug + image, from the Customizer.
 * Occasions whose tag does not exist or has no products are left out.
 *
 * @return array<int, array{label:string, term:WP_Term, image:int}>
 */
function mansu_occasions() {
	static $cache = null;
	if ( null !== $cache ) {
		return $cache;
	}
	$cache = array();
	for ( $i = 1; $i <= 4; $i++ ) {
		$label = trim( (string) mansu_opt( "occ{$i}_label" ) );
		$slug  = sanitize_title( (string) mansu_opt( "occ{$i}_tag" ) );
		if ( '' === $label || '' === $slug ) {
			continue;
		}
		$term = get_term_by( 'slug', $slug, 'product_tag' );
		if ( ! $term || is_wp_error( $term ) || ! $term->count ) {
			continue;
		}
		$cache[] = array(
			'label' => $label,
			'term'  => $term,
			'image' => absint( mansu_opt( "occ{$i}_image" ) ),
		);
	}
	return $cache;
}

/**
 * In-stock, catalogue-visible products for home-page rails.
 *
 * A plain WP_Query with WooCommerce's own visibility rules, so the "photographed
 * only" condition is applied exactly.
 *
 * @param array $args { orderby: 'date'|'popularity', limit: int, cat: string slug, photo: bool }.
 * @return WC_Product[]
 */
function mansu_products( $args ) {
	$args = wp_parse_args( $args, array( 'orderby' => 'date', 'limit' => 8, 'cat' => '', 'photo' => (bool) mansu_opt( 'hide_no_photo' ) ) );
	$q    = array(
		'post_type'           => 'product',
		'post_status'         => 'publish',
		'posts_per_page'      => (int) $args['limit'],
		'fields'              => 'ids',
		'no_found_rows'       => true,
		'ignore_sticky_posts' => true,
		'tax_query'           => WC()->query ? WC()->query->get_tax_query() : array(), // phpcs:ignore WordPress.DB.SlowDBQuery
		'meta_query'          => array( array( 'key' => '_stock_status', 'value' => 'instock' ) ), // phpcs:ignore WordPress.DB.SlowDBQuery
	);
	if ( $args['photo'] ) {
		$q['meta_query'][] = array( 'key' => '_thumbnail_id', 'compare' => 'EXISTS' );
	}
	if ( $args['cat'] ) {
		$q['tax_query'][] = array( 'taxonomy' => 'product_cat', 'field' => 'slug', 'terms' => $args['cat'] );
	}
	if ( 'popularity' === $args['orderby'] ) {
		$q['meta_key'] = 'total_sales'; // phpcs:ignore WordPress.DB.SlowDBQuery
		$q['orderby']  = array( 'meta_value_num' => 'DESC', 'date' => 'DESC' );
	} else {
		$q['orderby'] = 'date';
		$q['order']   = 'DESC';
	}
	return array_values( array_filter( array_map( 'wc_get_product', ( new WP_Query( $q ) )->posts ) ) );
}

/**
 * Image for a category tile: the category thumbnail, else the newest photographed product in it.
 *
 * @param WP_Term $term Category.
 * @return int Attachment ID or 0.
 */
function mansu_term_image_id( $term ) {
	$id = absint( get_term_meta( $term->term_id, 'thumbnail_id', true ) );
	if ( $id ) {
		return $id;
	}
	$key = 'mansu_term_img_' . $term->term_id;
	$id  = get_transient( $key );
	if ( false === $id ) {
		$found = function_exists( 'WC' ) ? mansu_products( array( 'limit' => 1, 'cat' => $term->slug, 'photo' => true ) ) : array();
		$id    = $found ? (int) $found[0]->get_image_id() : 0;
		set_transient( $key, $id, DAY_IN_SECONDS );
	}
	return (int) $id;
}
