<?php
/**
 * Shop filters: occasion, size, colour, price.
 *
 * Built on WooCommerce's own URL parameters (filter_size, filter_color,
 * query_type_*, min_price, max_price) plus product_tag for occasions, so the
 * results are WooCommerce's main query: server-rendered, paginated, crawlable.
 * Option counts show how many products each choice would leave, given the
 * other active filters.
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;

/**
 * Price bands in the shop currency.
 *
 * @return array<string, array{label:string,min:?int,max:?int}>
 */
function mansu_price_bands() {
	return array(
		'u300'    => array( 'label' => __( 'Under GH₵ 300', 'mansu-rose' ), 'min' => null, 'max' => 299 ),
		'300-400' => array( 'label' => __( 'GH₵ 300 – 400', 'mansu-rose' ), 'min' => 300, 'max' => 400 ),
		'o400'    => array( 'label' => __( 'Over GH₵ 400', 'mansu-rose' ), 'min' => 401, 'max' => null ),
	);
}

/*
 * The filter form submits checkbox groups as arrays and a price band name.
 * Turn them into the comma lists and min/max that WooCommerce reads, before it reads them.
 */
add_action(
	'init',
	function () {
		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- read-only shop filters.
		foreach ( array( 'filter_size', 'filter_color', 'product_tag' ) as $key ) {
			if ( isset( $_GET[ $key ] ) && is_array( $_GET[ $key ] ) ) {
				$_GET[ $key ] = implode( ',', array_map( 'sanitize_title', wp_unslash( $_GET[ $key ] ) ) );
			}
		}
		if ( isset( $_GET['band'] ) ) {
			$bands = mansu_price_bands();
			$band  = sanitize_key( wp_unslash( $_GET['band'] ) );
			unset( $_GET['band'] );
			if ( isset( $bands[ $band ] ) ) {
				if ( null !== $bands[ $band ]['min'] ) {
					$_GET['min_price'] = $bands[ $band ]['min'];
				}
				if ( null !== $bands[ $band ]['max'] ) {
					$_GET['max_price'] = $bands[ $band ]['max'];
				}
			}
		}
		if ( isset( $_GET['product_tag'] ) && '' === $_GET['product_tag'] ) {
			unset( $_GET['product_tag'] );
		}
		// phpcs:enable
	},
	1
);

/* product_tag in the query string also filters category archives (WordPress supports it as a public query var). */

/**
 * The active band id, if min/max match one.
 *
 * @return string
 */
function mansu_active_band() {
	// phpcs:disable WordPress.Security.NonceVerification.Recommended
	$min = isset( $_GET['min_price'] ) ? (int) $_GET['min_price'] : null;
	$max = isset( $_GET['max_price'] ) ? (int) $_GET['max_price'] : null;
	// phpcs:enable
	foreach ( mansu_price_bands() as $id => $b ) {
		if ( $b['min'] === $min && $b['max'] === $max ) {
			return $id;
		}
	}
	return '';
}

/**
 * Selected slugs for a GET list parameter.
 *
 * @param string $key Parameter.
 * @return string[]
 */
function mansu_selected( $key ) {
	// phpcs:ignore WordPress.Security.NonceVerification.Recommended
	$v = isset( $_GET[ $key ] ) ? wp_unslash( $_GET[ $key ] ) : '';
	return array_values( array_filter( array_map( 'sanitize_title', explode( ',', is_array( $v ) ? implode( ',', $v ) : (string) $v ) ) ) );
}

/**
 * Product IDs matching the current listing with one filter dimension removed.
 *
 * @param string $drop 'size' | 'color' | 'tag' | 'price'.
 * @return int[]
 */
function mansu_ids_without( $drop ) {
	global $wp_query;
	$vars = $wp_query->query_vars;
	$args = array(
		'post_type'              => 'product',
		'post_status'            => 'publish',
		'fields'                 => 'ids',
		'posts_per_page'         => -1,
		'no_found_rows'          => true,
		'update_post_meta_cache' => false,
		'update_post_term_cache' => false,
		's'                      => $vars['s'] ?? '',
		'meta_query'             => $vars['meta_query'] ?? array(), // phpcs:ignore WordPress.DB.SlowDBQuery
		'tax_query'              => array(), // phpcs:ignore WordPress.DB.SlowDBQuery
	);
	$cat = mansu_queried_term( 'product_cat' );
	if ( $cat ) {
		$args['tax_query'][] = array( 'taxonomy' => 'product_cat', 'field' => 'term_id', 'terms' => $cat->term_id );
	}
	foreach ( (array) ( $vars['tax_query'] ?? array() ) as $clause ) {
		if ( ! is_array( $clause ) || empty( $clause['taxonomy'] ) ) {
			continue;
		}
		if ( ( 'size' === $drop && 'pa_size' === $clause['taxonomy'] ) || ( 'color' === $drop && 'pa_color' === $clause['taxonomy'] ) ) {
			continue;
		}
		if ( in_array( $clause['taxonomy'], array( 'product_visibility', 'pa_size', 'pa_color' ), true ) ) {
			$args['tax_query'][] = $clause;
		}
	}
	$tags = mansu_selected( 'product_tag' );
	if ( 'tag' !== $drop && $tags ) {
		$args['tax_query'][] = array( 'taxonomy' => 'product_tag', 'field' => 'slug', 'terms' => $tags );
	}
	$tag_page = mansu_tag_page();
	if ( $tag_page ) {
		$args['tax_query'][] = array( 'taxonomy' => 'product_tag', 'field' => 'term_id', 'terms' => $tag_page->term_id );
	}
	// phpcs:disable WordPress.Security.NonceVerification.Recommended
	if ( 'price' !== $drop && ( isset( $_GET['min_price'] ) || isset( $_GET['max_price'] ) ) ) {
		$args['meta_query'][] = array(
			'key'     => '_price',
			'value'   => array( isset( $_GET['min_price'] ) ? (float) $_GET['min_price'] : 0, isset( $_GET['max_price'] ) ? (float) $_GET['max_price'] : PHP_INT_MAX ),
			'compare' => 'BETWEEN',
			'type'    => 'DECIMAL(10,2)',
		);
	}
	// phpcs:enable
	$key = 'mansu_ids_' . md5( wp_json_encode( $args ) );
	$ids = wp_cache_get( $key, 'mansu' );
	if ( false === $ids ) {
		$ids = get_transient( $key );
	}
	if ( false === $ids ) {
		$ids = ( new WP_Query( $args ) )->posts;
		set_transient( $key, $ids, 30 * MINUTE_IN_SECONDS );
	}
	wp_cache_set( $key, $ids, 'mansu' );
	return array_map( 'intval', $ids );
}

/**
 * Term counts within a set of products.
 *
 * @param int[]  $ids      Product IDs.
 * @param string $taxonomy Taxonomy.
 * @return array<int, int> term_id => count.
 */
function mansu_term_counts( $ids, $taxonomy ) {
	if ( ! $ids || ! taxonomy_exists( $taxonomy ) ) {
		return array();
	}
	$counts = array();
	foreach ( array_chunk( $ids, 1000 ) as $chunk ) {
		$rows = wp_get_object_terms( $chunk, $taxonomy, array( 'fields' => 'all_with_object_id' ) );
		if ( is_wp_error( $rows ) ) {
			continue;
		}
		foreach ( $rows as $t ) {
			$counts[ $t->term_id ] = ( $counts[ $t->term_id ] ?? 0 ) + 1;
		}
	}
	return $counts;
}

/**
 * Products per price band within a set of products.
 *
 * @param int[] $ids Product IDs.
 * @return array<string, int>
 */
function mansu_band_counts( $ids ) {
	global $wpdb;
	$out = array_fill_keys( array_keys( mansu_price_bands() ), 0 );
	if ( ! $ids ) {
		return $out;
	}
	$prices = array();
	foreach ( array_chunk( $ids, 1000 ) as $chunk ) {
		$in   = implode( ',', array_map( 'intval', $chunk ) );
		$rows = $wpdb->get_results( "SELECT post_id, MIN(CAST(meta_value AS DECIMAL(10,2))) AS p FROM {$wpdb->postmeta} WHERE meta_key = '_price' AND meta_value <> '' AND post_id IN ($in) GROUP BY post_id" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared,WordPress.DB.DirectDatabaseQuery
		foreach ( $rows as $r ) {
			$prices[] = (float) $r->p;
		}
	}
	foreach ( $prices as $p ) {
		foreach ( mansu_price_bands() as $id => $b ) {
			if ( ( null === $b['min'] || $p >= $b['min'] ) && ( null === $b['max'] || $p <= $b['max'] ) ) {
				++$out[ $id ];
			}
		}
	}
	return $out;
}

/**
 * Removable chips for the active filters.
 */
function mansu_active_chips() {
	$chips = array();
	$base  = remove_query_arg( array( 'paged', 'product-page' ) );
	// phpcs:ignore WordPress.Security.NonceVerification.Recommended
	$s = isset( $_GET['s'] ) ? sanitize_text_field( wp_unslash( $_GET['s'] ) ) : '';
	foreach ( array( 'product_tag' => 'product_tag', 'filter_size' => 'pa_size', 'filter_color' => 'pa_color' ) as $param => $tax ) {
		$sel = mansu_selected( $param );
		foreach ( $sel as $slug ) {
			$term = get_term_by( 'slug', $slug, $tax );
			$rest = array_diff( $sel, array( $slug ) );
			$url  = $rest ? add_query_arg( $param, implode( ',', $rest ), $base ) : remove_query_arg( array( $param, 'query_type_' . substr( $tax, 3 ) ), $base );
			$label = $term ? $term->name : $slug;
			if ( 'pa_size' === $tax ) {
				/* translators: %s: size */
				$label = sprintf( __( 'Size %s', 'mansu-rose' ), $label );
			}
			$chips[] = array( $label, $url );
		}
	}
	$band = mansu_active_band();
	if ( $band ) {
		$chips[] = array( mansu_price_bands()[ $band ]['label'], remove_query_arg( array( 'min_price', 'max_price' ), $base ) );
	}
	if ( ! $chips ) {
		return;
	}
	echo '<div class="chips" aria-label="' . esc_attr__( 'Active filters', 'mansu-rose' ) . '">';
	foreach ( $chips as $c ) {
		/* translators: %s: filter name */
		echo '<a class="chip" href="' . esc_url( $c[1] ) . '" aria-label="' . esc_attr( sprintf( __( 'Remove filter: %s', 'mansu-rose' ), $c[0] ) ) . '">' . esc_html( $c[0] ) . ' <span aria-hidden="true">×</span></a>';
	}
	if ( count( $chips ) > 1 ) {
		$clear = mansu_listing_url( $s );
		echo '<a class="chip" href="' . esc_url( $clear ) . '">' . esc_html__( 'Clear all', 'mansu-rose' ) . '</a>';
	}
	echo '</div>';
}

/**
 * The queried term when it belongs to $taxonomy (a category page may also carry ?product_tag=).
 *
 * @param string $taxonomy Taxonomy.
 * @return WP_Term|null
 */
function mansu_queried_term( $taxonomy ) {
	$qo = get_queried_object();
	return ( $qo instanceof WP_Term && $taxonomy === $qo->taxonomy ) ? $qo : null;
}

/**
 * The product tag whose own page this is (/product-tag/office/), not a tag chosen as a filter.
 *
 * @return WP_Term|null
 */
function mansu_tag_page() {
	// phpcs:ignore WordPress.Security.NonceVerification.Recommended
	return isset( $_GET['product_tag'] ) ? null : mansu_queried_term( 'product_tag' );
}

/**
 * The current listing without any filters.
 *
 * @param string $s Search phrase, if searching.
 * @return string URL.
 */
function mansu_listing_url( $s = '' ) {
	if ( is_search() ) {
		return add_query_arg( array( 's' => $s, 'post_type' => 'product' ), home_url( '/' ) );
	}
	$here = mansu_queried_term( 'product_cat' ) ? mansu_queried_term( 'product_cat' ) : mansu_tag_page();
	if ( $here ) {
		$link = get_term_link( $here );
		return is_wp_error( $link ) ? wc_get_page_permalink( 'shop' ) : $link;
	}
	return wc_get_page_permalink( 'shop' );
}

/**
 * Number of active filters (for the Filter button label).
 *
 * @return int
 */
function mansu_active_filter_count() {
	return count( mansu_selected( 'product_tag' ) ) + count( mansu_selected( 'filter_size' ) ) + count( mansu_selected( 'filter_color' ) ) + ( mansu_active_band() ? 1 : 0 );
}

/**
 * The filter drawer form (printed once, in the archive template).
 */
function mansu_filter_form() {
	// Category and tag pages filter in place; everything else submits to /?post_type=product,
	// where occasion tags combine with the other filters reliably.
	$cat     = mansu_queried_term( 'product_cat' );
	$here    = $cat ? $cat : mansu_tag_page();
	$on_root = ! $here;
	$action  = $here ? get_term_link( $here ) : home_url( '/' );
	$sel_tag   = mansu_selected( 'product_tag' );
	$sel_size  = mansu_selected( 'filter_size' );
	$sel_color = mansu_selected( 'filter_color' );
	$band      = mansu_active_band();
	$tag_n     = mansu_term_counts( mansu_ids_without( 'tag' ), 'product_tag' );
	$size_n    = mansu_term_counts( mansu_ids_without( 'size' ), 'pa_size' );
	$color_n   = mansu_term_counts( mansu_ids_without( 'color' ), 'pa_color' );
	$band_n    = mansu_band_counts( mansu_ids_without( 'price' ) );

	echo '<form class="filter-form" method="get" action="' . esc_url( $action ) . '" id="filterForm">';
	// phpcs:disable WordPress.Security.NonceVerification.Recommended
	foreach ( array( 's', 'orderby' ) as $keep ) {
		if ( isset( $_GET[ $keep ] ) ) {
			echo '<input type="hidden" name="' . esc_attr( $keep ) . '" value="' . esc_attr( sanitize_text_field( wp_unslash( $_GET[ $keep ] ) ) ) . '">';
		}
	}
	// phpcs:enable
	if ( $on_root ) {
		echo '<input type="hidden" name="post_type" value="product">';
	}

	$occ = mansu_occasions();
	if ( $occ && ! mansu_tag_page() ) {
		echo '<fieldset class="fgroup"><legend>' . esc_html__( 'Occasion', 'mansu-rose' ) . '</legend>';
		foreach ( $occ as $o ) {
			$n = $tag_n[ $o['term']->term_id ] ?? 0;
			printf(
				'<label class="opt"%5$s><input type="checkbox" name="product_tag[]" value="%1$s"%2$s> %3$s<small>%4$d</small></label>',
				esc_attr( $o['term']->slug ),
				checked( in_array( $o['term']->slug, $sel_tag, true ), true, false ),
				esc_html( $o['label'] ),
				(int) $n,
				$n ? '' : ' data-zero'
			);
		}
		echo '</fieldset>';
	}

	$sizes = get_terms( array( 'taxonomy' => 'pa_size', 'hide_empty' => true, 'orderby' => 'menu_order' ) );
	if ( $sizes && ! is_wp_error( $sizes ) ) {
		echo '<fieldset class="fgroup"><legend>' . esc_html__( 'Size', 'mansu-rose' ) . '</legend><div class="size-grid">';
		foreach ( $sizes as $t ) {
			$n = $size_n[ $t->term_id ] ?? 0;
			printf(
				'<label class="szb%5$s"><input type="checkbox" name="filter_size[]" value="%1$s"%2$s aria-label="%6$s"><span>%3$s</span></label>',
				esc_attr( $t->slug ),
				checked( in_array( $t->slug, $sel_size, true ), true, false ),
				esc_html( $t->name ),
				(int) $n,
				$n ? '' : ' zero',
				/* translators: 1: size, 2: count */
				esc_attr( sprintf( _n( 'Size %1$s, %2$d style', 'Size %1$s, %2$d styles', $n, 'mansu-rose' ), $t->name, $n ) )
			);
		}
		echo '</div><input type="hidden" name="query_type_size" value="or"></fieldset>';
	}

	$colors = get_terms( array( 'taxonomy' => 'pa_color', 'hide_empty' => true ) );
	if ( $colors && ! is_wp_error( $colors ) ) {
		echo '<fieldset class="fgroup"><legend>' . esc_html__( 'Colour', 'mansu-rose' ) . '</legend><div class="swatch-grid">';
		foreach ( $colors as $t ) {
			$n = $color_n[ $t->term_id ] ?? 0;
			if ( ! $n && ! in_array( $t->slug, $sel_color, true ) ) {
				continue;
			}
			printf(
				'<label class="swopt"><input type="checkbox" name="filter_color[]" value="%1$s"%2$s><i style="background:%3$s"></i>%4$s <small>(%5$d)</small></label>',
				esc_attr( $t->slug ),
				checked( in_array( $t->slug, $sel_color, true ), true, false ),
				esc_attr( mansu_swatch( $t ) ),
				esc_html( $t->name ),
				(int) $n
			);
		}
		echo '</div><input type="hidden" name="query_type_color" value="or"></fieldset>';
	}

	echo '<fieldset class="fgroup"><legend>' . esc_html__( 'Price', 'mansu-rose' ) . '</legend>';
	echo '<label class="opt"><input type="radio" name="band" value=""' . checked( '', $band, false ) . '> ' . esc_html__( 'Any price', 'mansu-rose' ) . '</label>';
	foreach ( mansu_price_bands() as $id => $b ) {
		printf(
			'<label class="opt"%5$s><input type="radio" name="band" value="%1$s"%2$s> %3$s<small>%4$d</small></label>',
			esc_attr( $id ),
			checked( $id, $band, false ),
			esc_html( $b['label'] ),
			(int) $band_n[ $id ],
			$band_n[ $id ] ? '' : ' data-zero'
		);
	}
	echo '</fieldset>';
	echo '</form>';
}
