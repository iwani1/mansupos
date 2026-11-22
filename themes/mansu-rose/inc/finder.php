<?php
/**
 * Style Finder: three questions (occasion, size, budget) on the home page.
 *
 * The form submits to the normal shop with WooCommerce's own filter parameters
 * (product_tag, filter_size, band → min/max_price), so the answers land on a
 * server-rendered, paginated result page and work without JavaScript.
 * With JavaScript, ?wc-ajax=mansu_finder returns live counts for each answer.
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;

add_action( 'wc_ajax_mansu_finder', 'mansu_ajax_finder' );

/**
 * Sizes offered in the Finder: pa_size terms that have products, in menu order.
 *
 * @return WP_Term[]
 */
function mansu_finder_sizes() {
	$terms = get_terms( array( 'taxonomy' => 'pa_size', 'hide_empty' => true, 'orderby' => 'menu_order' ) );
	return ( $terms && ! is_wp_error( $terms ) ) ? $terms : array();
}

/**
 * Clean a Finder selection from request data.
 *
 * @param array $src $_GET or similar.
 * @return array{occ:string,size:string,band:string}
 */
function mansu_finder_selection( $src ) {
	$occ  = isset( $src['product_tag'] ) ? sanitize_title( wp_unslash( $src['product_tag'] ) ) : '';
	$size = isset( $src['filter_size'] ) ? sanitize_title( wp_unslash( $src['filter_size'] ) ) : '';
	$band = isset( $src['band'] ) ? sanitize_key( wp_unslash( $src['band'] ) ) : '';
	$tags = wp_list_pluck( wp_list_pluck( mansu_occasions(), 'term' ), 'slug' );
	return array(
		'occ'  => in_array( $occ, $tags, true ) ? $occ : '',
		'size' => $size && term_exists( $size, 'pa_size' ) ? $size : '',
		'band' => isset( mansu_price_bands()[ $band ] ) ? $band : '',
	);
}

/**
 * Product IDs that match a selection, leaving out one question.
 * Same catalogue rules as the shop: published, catalogue-visible, photographed when that setting is on.
 *
 * @param array  $sel  Selection.
 * @param string $drop 'occ' | 'size' | 'band' | ''.
 * @return int[]
 */
function mansu_finder_ids( $sel, $drop = '' ) {
	$args = array(
		'post_type'              => 'product',
		'post_status'            => 'publish',
		'fields'                 => 'ids',
		'posts_per_page'         => -1,
		'no_found_rows'          => true,
		'update_post_meta_cache' => false,
		'update_post_term_cache' => false,
		'tax_query'              => WC()->query ? WC()->query->get_tax_query() : array(), // phpcs:ignore WordPress.DB.SlowDBQuery
		'meta_query'             => array(), // phpcs:ignore WordPress.DB.SlowDBQuery
	);
	if ( mansu_opt( 'hide_no_photo' ) ) {
		$args['meta_query'][] = array( 'key' => '_thumbnail_id', 'compare' => 'EXISTS' );
	}
	if ( 'occ' !== $drop && $sel['occ'] ) {
		$args['tax_query'][] = array( 'taxonomy' => 'product_tag', 'field' => 'slug', 'terms' => $sel['occ'] );
	}
	if ( 'size' !== $drop && $sel['size'] ) {
		$args['tax_query'][] = array( 'taxonomy' => 'pa_size', 'field' => 'slug', 'terms' => $sel['size'] );
	}
	if ( 'band' !== $drop && $sel['band'] ) {
		$b                    = mansu_price_bands()[ $sel['band'] ];
		$args['meta_query'][] = array(
			'key'     => '_price',
			'value'   => array( null === $b['min'] ? 0 : $b['min'], null === $b['max'] ? PHP_INT_MAX : $b['max'] ),
			'compare' => 'BETWEEN',
			'type'    => 'DECIMAL(10,2)',
		);
	}
	$key = 'mansu_fd_' . md5( wp_json_encode( $args ) );
	$ids = get_transient( $key );
	if ( false === $ids ) {
		$ids = ( new WP_Query( $args ) )->posts;
		set_transient( $key, $ids, 30 * MINUTE_IN_SECONDS );
	}
	return array_map( 'intval', $ids );
}

/**
 * Counts for every answer, the total and a few thumbnails, for a selection.
 *
 * @param array $sel Selection.
 * @return array
 */
function mansu_finder_state( $sel ) {
	$occ_n  = mansu_term_counts( mansu_finder_ids( $sel, 'occ' ), 'product_tag' );
	$size_n = mansu_term_counts( mansu_finder_ids( $sel, 'size' ), 'pa_size' );
	$band_n = mansu_band_counts( mansu_finder_ids( $sel, 'band' ) );
	$ids    = mansu_finder_ids( $sel );

	$out = array( 'occ' => array(), 'size' => array(), 'band' => $band_n, 'total' => count( $ids ), 'thumbs' => array(), 'url' => mansu_finder_url( $sel ) );
	foreach ( mansu_occasions() as $o ) {
		$out['occ'][ $o['term']->slug ] = (int) ( $occ_n[ $o['term']->term_id ] ?? 0 );
	}
	foreach ( mansu_finder_sizes() as $t ) {
		$out['size'][ $t->slug ] = (int) ( $size_n[ $t->term_id ] ?? 0 );
	}
	foreach ( array_slice( $ids, 0, 4 ) as $id ) {
		$src = wp_get_attachment_image_src( get_post_thumbnail_id( $id ), 'thumbnail' );
		if ( $src ) {
			$out['thumbs'][] = $src[0];
		}
	}
	return $out;
}

/**
 * The shop URL for a selection (what the form submits to without JavaScript).
 *
 * @param array $sel Selection.
 * @return string
 */
function mansu_finder_url( $sel ) {
	$args = array( 'post_type' => 'product' );
	if ( $sel['occ'] ) {
		$args['product_tag'] = $sel['occ'];
	}
	if ( $sel['size'] ) {
		$args['filter_size']     = $sel['size'];
		$args['query_type_size'] = 'or';
	}
	if ( $sel['band'] ) {
		$b = mansu_price_bands()[ $sel['band'] ];
		if ( null !== $b['min'] ) {
			$args['min_price'] = $b['min'];
		}
		if ( null !== $b['max'] ) {
			$args['max_price'] = $b['max'];
		}
	}
	return add_query_arg( $args, home_url( '/' ) );
}

/**
 * ?wc-ajax=mansu_finder&product_tag=office&filter_size=m&band=u300
 */
function mansu_ajax_finder() {
	// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- public, read-only.
	$state = mansu_finder_state( mansu_finder_selection( $_GET ) );
	header( 'Cache-Control: public, max-age=300' );
	wp_send_json( $state );
}

/**
 * The Finder form. Counts are printed by the server, so it is useful before any script runs.
 */
function mansu_finder_form() {
	$sel   = array( 'occ' => '', 'size' => '', 'band' => '' );
	$state = mansu_finder_state( $sel );
	$opt   = function ( $name, $value, $label, $n ) {
		printf(
			'<label class="fopt%4$s" data-k="%1$s" data-v="%2$s"><input type="radio" name="%1$s" value="%2$s"><span>%3$s <small>%5$d</small></span></label>',
			esc_attr( $name ),
			esc_attr( $value ),
			esc_html( $label ),
			$n ? '' : ' zero',
			(int) $n
		);
	};
	?>
	<form class="finder" id="finder" method="get" action="<?php echo esc_url( home_url( '/' ) ); ?>" aria-labelledby="finder-h">
		<input type="hidden" name="post_type" value="product">
		<h2 id="finder-h"><?php echo esc_html( mansu_opt( 'finder_title' ) ); ?></h2>
		<p class="finder-lede"><?php echo esc_html( mansu_opt( 'finder_lede' ) ); ?></p>
		<div class="fsteps" aria-hidden="true"><span></span><span></span><span></span></div>
		<?php if ( mansu_occasions() ) : ?>
		<fieldset class="fstep"><legend><i>1</i> <?php esc_html_e( 'Where are you going?', 'mansu-rose' ); ?></legend><div class="fopts">
			<?php foreach ( mansu_occasions() as $o ) { $opt( 'product_tag', $o['term']->slug, $o['label'], $state['occ'][ $o['term']->slug ] ?? 0 ); } ?>
		</div></fieldset>
		<?php endif; ?>
		<?php if ( mansu_finder_sizes() ) : ?>
		<fieldset class="fstep"><legend><i>2</i> <?php esc_html_e( 'Your size', 'mansu-rose' ); ?></legend><div class="fopts">
			<?php foreach ( mansu_finder_sizes() as $t ) { $opt( 'filter_size', $t->slug, $t->name, $state['size'][ $t->slug ] ?? 0 ); } ?>
		</div><input type="hidden" name="query_type_size" value="or"></fieldset>
		<?php endif; ?>
		<fieldset class="fstep"><legend><i>3</i> <?php esc_html_e( 'Your budget', 'mansu-rose' ); ?></legend><div class="fopts">
			<?php foreach ( mansu_price_bands() as $id => $b ) { $opt( 'band', $id, $b['label'], $state['band'][ $id ] ?? 0 ); } ?>
		</div></fieldset>
		<div class="fres">
			<span class="fthumbs" aria-hidden="true"><?php foreach ( $state['thumbs'] as $src ) : ?><img src="<?php echo esc_url( $src ); ?>" alt="" width="34" height="34" loading="lazy"><?php endforeach; ?></span>
			<p class="fcount" aria-live="polite"><?php echo esc_html( sprintf( /* translators: %d: count */ _n( '%d look matches', '%d looks match', $state['total'], 'mansu-rose' ), $state['total'] ) ); ?></p>
			<button class="btn-primary" type="submit"><?php echo esc_html( sprintf( /* translators: %d: count */ __( 'Show %d looks', 'mansu-rose' ), $state['total'] ) ); ?></button>
		</div>
	</form>
	<?php
}
